import { Prisma, ReservationStatus } from '../prisma/client';
import { PricingClient } from '../pricing/pricing.types';

/**
 * A reservation row read under `SELECT ... FOR UPDATE`.
 *
 * `totalAmountText` is the database's own decimal rendering (`"8700.00"`). Money
 * crosses the service boundary as that string so it never round-trips through a
 * float.
 */
export type LockedReservation = {
  id: string;
  reservationNumber: string;
  userId: string;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  confirmedAt: Date | null;
  totalAmountText: string;
  currency: string;
};

type LockRow = {
  id: string;
  reservationNumber: string;
  userId: string;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  confirmedAt: Date | null;
  totalAmountText: string;
  currency: string;
};

const SELECT_COLUMNS = Prisma.sql`
  "id",
  "reservationNumber",
  "userId",
  "status",
  "holdExpiresAt",
  "confirmedAt",
  "totalAmount"::text AS "totalAmountText",
  "currency"
`;

/**
 * Locks one reservation row for the rest of the transaction.
 *
 * This is the serialisation point shared by hold expiry, payment-session
 * creation, and payment confirmation. Any path that decides a reservation's fate
 * must come through here first, otherwise it is acting on a snapshot that a
 * concurrent transaction may already have invalidated.
 */
export async function lockReservationById(
  tx: PricingClient,
  reservationId: string,
): Promise<LockedReservation | null> {
  const rows = await tx.$queryRaw<LockRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM "reservations"
    WHERE "id" = ${reservationId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function lockReservationByNumber(
  tx: PricingClient,
  reservationNumber: string,
): Promise<LockedReservation | null> {
  const rows = await tx.$queryRaw<LockRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM "reservations"
    WHERE "reservationNumber" = ${reservationNumber}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** True while the reservation's inventory hold is still reserving capacity. */
export function isHoldLive(
  reservation: Pick<LockedReservation, 'holdExpiresAt'>,
  now: Date,
): boolean {
  return (
    reservation.holdExpiresAt !== null &&
    reservation.holdExpiresAt.getTime() > now.getTime()
  );
}
