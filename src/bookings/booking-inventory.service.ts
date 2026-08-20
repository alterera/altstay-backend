import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../prisma/client';
import { PricingClient } from '../pricing/pricing.types';
import { HOLDING_STATUSES } from './booking-lifecycle';
import { toUtcDateString } from './booking.utils';

type InventoryLockRow = {
  dateText: string;
  totalRooms: number;
  blockedRooms: number;
  soldRooms: number;
};

export type NightAvailability = {
  date: string;
  totalRooms: number;
  blockedRooms: number;
  soldRooms: number;
  heldRooms: number;
  freeRooms: number;
};

export type AvailabilityLookup = {
  nights: NightAvailability[];
  /** Nights with no `room_inventory` row at all — never bookable. */
  missingDates: string[];
};

/**
 * Rooms a guest can actually take for one night.
 *
 * `soldRooms` covers confirmed stays; `heldRooms` covers reservations sitting in
 * PAYMENT_PENDING with an unexpired hold. Phase A never increments `soldRooms`,
 * so holds are the only thing consuming inventory before payment exists.
 */
export function computeFreeRooms(row: {
  totalRooms: number;
  blockedRooms: number;
  soldRooms: number;
  heldRooms: number;
}): number {
  return row.totalRooms - row.blockedRooms - row.soldRooms - row.heldRooms;
}

@Injectable()
export class BookingInventoryService {
  /**
   * Takes a row lock on every night's inventory, then verifies availability
   * against the freshly-visible hold total.
   *
   * Must run inside a transaction. The `FOR UPDATE` is what serializes competing
   * bookings: the second transaction blocks here until the first commits, and
   * because subsequent statements in READ COMMITTED take a new snapshot, its hold
   * query then sees the winner's hold.
   *
   * @throws ConflictException when any night is short, or has no inventory row
   */
  async lockAndAssertAvailable(
    tx: PricingClient,
    roomTypeId: string,
    nights: Date[],
    roomsNeeded: number,
    now: Date = new Date(),
  ): Promise<NightAvailability[]> {
    const { nights: availability, missingDates } =
      await this.lockAndLoadAvailability(tx, roomTypeId, nights, now);

    if (missingDates.length) {
      throw new ConflictException(
        `No inventory is loaded for ${missingDates.join(', ')}`,
      );
    }

    const short = availability.filter((night) => night.freeRooms < roomsNeeded);
    if (short.length) {
      throw new ConflictException(
        `Only ${Math.min(...short.map((n) => Math.max(n.freeRooms, 0)))} room(s) ` +
          `left for ${short.map((n) => n.date).join(', ')}`,
      );
    }

    return availability;
  }

  /**
   * The locking half of {@link lockAndAssertAvailable}, reporting shortfalls
   * instead of throwing.
   *
   * Payment confirmation needs this: a late payment with no rooms left is a
   * refund to record, not an error to abort the transaction with.
   */
  async lockAndLoadAvailability(
    tx: PricingClient,
    roomTypeId: string,
    nights: Date[],
    now: Date = new Date(),
  ): Promise<AvailabilityLookup> {
    const dateStrings = nights.map(toUtcDateString);
    const dateList = Prisma.join(
      dateStrings.map((date) => Prisma.sql`${date}::date`),
    );

    // Ordered by date so concurrent bookings for the same room type always take
    // the locks in the same sequence, which keeps them queuing instead of
    // deadlocking.
    const rows = await tx.$queryRaw<InventoryLockRow[]>`
      SELECT
        "date"::text AS "dateText",
        "totalRooms",
        "blockedRooms",
        "soldRooms"
      FROM "room_inventory"
      WHERE "roomTypeId" = ${roomTypeId}::uuid
        AND "date" IN (${dateList})
      ORDER BY "date" ASC
      FOR UPDATE
    `;

    const lockedByDate = new Map(rows.map((row) => [row.dateText, row]));
    const missingDates = dateStrings.filter((date) => !lockedByDate.has(date));

    const heldByDate = await this.activeHoldQuantities(
      tx,
      roomTypeId,
      nights,
      now,
    );

    const availability: NightAvailability[] = dateStrings
      .filter((date) => lockedByDate.has(date))
      .map((date) => {
        const row = lockedByDate.get(date)!;
        const heldRooms = heldByDate.get(date) ?? 0;
        return {
          date,
          totalRooms: Number(row.totalRooms),
          blockedRooms: Number(row.blockedRooms),
          soldRooms: Number(row.soldRooms),
          heldRooms,
          freeRooms: computeFreeRooms({
            totalRooms: Number(row.totalRooms),
            blockedRooms: Number(row.blockedRooms),
            soldRooms: Number(row.soldRooms),
            heldRooms,
          }),
        };
      });

    return { nights: availability, missingDates };
  }

  /**
   * Held room count per night, keyed by `yyyy-MM-dd`. Counts only unexpired holds
   * whose reservation is still in a holding status — a hold row belonging to an
   * EXPIRED or CANCELLED reservation releases inventory immediately, even before
   * the maintenance job deletes it.
   */
  async activeHoldQuantities(
    tx: PricingClient,
    roomTypeId: string,
    nights: Date[],
    now: Date = new Date(),
  ): Promise<Map<string, number>> {
    const grouped = await tx.inventoryHold.groupBy({
      by: ['date'],
      where: {
        roomTypeId,
        date: { in: nights },
        expiresAt: { gt: now },
        reservation: { status: { in: [...HOLDING_STATUSES] } },
      },
      _sum: { quantity: true },
    });

    return new Map(
      grouped.map((row) => [toUtcDateString(row.date), row._sum.quantity ?? 0]),
    );
  }

  /**
   * Turns a reservation's live holds into sold rooms.
   *
   * Held and sold rooms both subtract from availability, so doing the increment
   * and the hold deletion in one transaction keeps free rooms constant across the
   * conversion — there is no instant where the room looks bookable again.
   *
   * @returns how many inventory rows were incremented; 0 means there were no holds
   */
  async convertHoldsToSold(
    tx: PricingClient,
    reservationId: string,
  ): Promise<number> {
    // Ordered lock first, so concurrent confirmations queue rather than deadlock.
    // The UPDATE below would take the same locks in whatever order it scans.
    await tx.$queryRaw`
      SELECT ri."roomTypeId", ri."date"
      FROM "room_inventory" ri
      JOIN (
        SELECT DISTINCT "roomTypeId", "date"
        FROM "inventory_holds"
        WHERE "reservationId" = ${reservationId}::uuid
      ) h ON h."roomTypeId" = ri."roomTypeId" AND h."date" = ri."date"
      ORDER BY ri."roomTypeId" ASC, ri."date" ASC
      FOR UPDATE OF ri
    `;

    const updated = await tx.$executeRaw`
      UPDATE "room_inventory" ri
      SET "soldRooms" = ri."soldRooms" + held."quantity"
      FROM (
        SELECT "roomTypeId", "date", SUM("quantity")::int AS "quantity"
        FROM "inventory_holds"
        WHERE "reservationId" = ${reservationId}::uuid
        GROUP BY "roomTypeId", "date"
      ) held
      WHERE ri."roomTypeId" = held."roomTypeId" AND ri."date" = held."date"
    `;

    await this.releaseHolds(tx, reservationId);
    return updated;
  }

  /**
   * Sells rooms that are not backed by a hold.
   *
   * Used by the late-payment path, where the hold has lapsed or been deleted and
   * capacity has to be re-checked from scratch. Callers must have already
   * verified availability under the same locks.
   */
  async sellRooms(
    tx: PricingClient,
    roomTypeId: string,
    nights: Date[],
    quantity: number,
  ): Promise<number> {
    const dateList = Prisma.join(
      nights.map((date) => Prisma.sql`${toUtcDateString(date)}::date`),
    );

    return tx.$executeRaw`
      UPDATE "room_inventory"
      SET "soldRooms" = "soldRooms" + ${quantity}
      WHERE "roomTypeId" = ${roomTypeId}::uuid
        AND "date" IN (${dateList})
    `;
  }

  /** Releases every hold attached to a reservation. Used by expiry. */
  async releaseHolds(
    tx: PricingClient,
    reservationId: string,
  ): Promise<number> {
    const { count } = await tx.inventoryHold.deleteMany({
      where: { reservationId },
    });
    return count;
  }

  buildHoldRows(
    reservationId: string,
    roomTypeId: string,
    nights: Date[],
    quantity: number,
    expiresAt: Date,
  ): Prisma.InventoryHoldCreateManyInput[] {
    return nights.map((date) => ({
      reservationId,
      roomTypeId,
      date,
      quantity,
      expiresAt,
    }));
  }
}
