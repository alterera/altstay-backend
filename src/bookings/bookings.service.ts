import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ReservationStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { Quote } from '../pricing/pricing.types';
import { BookingIdempotencyService } from './booking-idempotency.service';
import { BookingInventoryService } from './booking-inventory.service';
import { BookingNumberService } from './booking-number.service';
import {
  BookingValidationService,
  ValidatedBooking,
} from './booking-validation.service';
import { assertTransition } from './booking-lifecycle';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import {
  BOOKING_INCLUDE,
  BookingResponse,
  toBookingResponse,
} from './dto/booking-response.dto';

const DEFAULT_HOLD_TTL_MINUTES = 10;
/** Only ever consumed by an astronomically unlikely reservation number clash. */
const CREATE_ATTEMPTS = 3;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly validation: BookingValidationService,
    private readonly pricing: PricingService,
    private readonly inventory: BookingInventoryService,
    private readonly bookingNumber: BookingNumberService,
    private readonly idempotency: BookingIdempotencyService,
  ) {}

  get holdTtlMs(): number {
    const minutes = Number(
      this.config.get<string>('BOOKING_HOLD_TTL_MINUTES') ??
        DEFAULT_HOLD_TTL_MINUTES,
    );
    const safe =
      Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_HOLD_TTL_MINUTES;
    return safe * 60 * 1000;
  }

  /**
   * Creates a PAYMENT_PENDING reservation with inventory holds.
   *
   * Everything before BEGIN is advisory: it produces fast, specific errors for
   * bad input but never determines what gets written. Availability and price are
   * both resolved inside the transaction, under the inventory row locks.
   */
  async createBooking(
    userId: string,
    dto: CreateBookingDto,
    idempotencyKey: string,
  ): Promise<BookingResponse> {
    const validated = await this.validation.validate(dto);

    const claim = await this.idempotency.claim(
      userId,
      idempotencyKey,
      this.idempotency.hashRequest(dto),
    );

    if (claim.outcome === 'REPLAY') {
      return this.replay(claim.reservationId);
    }

    try {
      return await this.createWithRetry(userId, dto, validated, claim.claimId);
    } catch (error) {
      // Free the key so the client can correct the problem and retry with it.
      await this.idempotency.release(claim.claimId);
      throw error;
    }
  }

  private async createWithRetry(
    userId: string,
    dto: CreateBookingDto,
    validated: ValidatedBooking,
    claimId: string,
  ): Promise<BookingResponse> {
    for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
      try {
        return await this.createInTransaction(userId, dto, validated, claimId);
      } catch (error) {
        if (attempt < CREATE_ATTEMPTS && this.isReservationNumberClash(error)) {
          this.logger.warn(
            `Reservation number collision on attempt ${attempt}; retrying`,
          );
          continue;
        }
        throw error;
      }
    }
    // Unreachable: the final attempt either returns or rethrows.
    throw new Error('Booking creation exhausted its retries');
  }

  private async createInTransaction(
    userId: string,
    dto: CreateBookingDto,
    validated: ValidatedBooking,
    claimId: string,
  ): Promise<BookingResponse> {
    const { property, roomType, ratePlan, nights, checkIn, checkOut, rooms } =
      validated;

    const reservation = await this.prisma.$transaction(
      async (tx) => {
        const now = new Date();

        await this.inventory.lockAndAssertAvailable(
          tx,
          roomType.id,
          nights,
          rooms,
          now,
        );

        // Authoritative price: read under the same locks that guarantee the
        // rooms, so the amount cannot be based on a stale pre-check.
        const quote = await this.pricing.loadAndQuote(
          tx,
          ratePlan.id,
          nights,
          rooms,
        );

        const reservationNumber = await this.bookingNumber.generateUnique(
          tx,
          now,
        );
        const holdExpiresAt = new Date(now.getTime() + this.holdTtlMs);

        const created = await tx.reservation.create({
          data: {
            reservationNumber,
            userId,
            propertyId: property.id,
            checkIn,
            checkOut,
            status: ReservationStatus.PAYMENT_PENDING,
            subtotal: quote.subtotal,
            taxAmount: quote.taxAmount,
            discountAmount: quote.discountAmount,
            totalAmount: quote.totalAmount,
            currency: quote.currency,
            holdExpiresAt,
            companyName: dto.businessBooking?.companyName ?? null,
            gstin: dto.businessBooking?.gstin ?? null,
            billingAddress: dto.businessBooking?.billingAddress ?? null,
            items: {
              create: [
                {
                  roomTypeId: roomType.id,
                  ratePlanId: ratePlan.id,
                  quantity: rooms,
                  checkIn,
                  checkOut,
                  unitPrice: quote.subtotal / rooms,
                  subtotal: quote.subtotal,
                  taxAmount: quote.taxAmount,
                  totalAmount: quote.totalAmount,
                  roomTypeName: roomType.name,
                  ratePlanName: ratePlan.name,
                  mealPlanName: ratePlan.mealPlanName,
                  cancellationPolicyText: ratePlan.cancellationPolicyText,
                  snapshotJson: this.buildSnapshot(validated, quote, now),
                },
              ],
            },
            guests: {
              create: [
                {
                  firstName: dto.guest.firstName,
                  lastName: dto.guest.lastName ?? null,
                  email: dto.guest.email ?? null,
                  phone: dto.guest.phone ?? null,
                },
              ],
            },
          },
          include: BOOKING_INCLUDE,
        });

        await tx.inventoryHold.createMany({
          data: this.inventory.buildHoldRows(
            created.id,
            roomType.id,
            nights,
            rooms,
            holdExpiresAt,
          ),
        });

        // Same transaction as the reservation: a committed booking always has a
        // committed claim, so a retried request can never create a second one.
        await this.idempotency.markCompleted(tx, claimId, created.id);

        return created;
      },
      { timeout: 20_000, maxWait: 15_000 },
    );

    return toBookingResponse(reservation);
  }

  /**
   * Frozen record of what the guest agreed to. Read from this, never from the
   * live rate plan, so later admin price edits cannot rewrite history.
   */
  private buildSnapshot(
    validated: ValidatedBooking,
    quote: Quote,
    quotedAt: Date,
  ): Prisma.InputJsonValue {
    return {
      propertySlug: validated.property.slug,
      propertyName: validated.property.name,
      roomTypeName: validated.roomType.name,
      ratePlanName: validated.ratePlan.name,
      mealPlanName: validated.ratePlan.mealPlanName,
      cancellationPolicyText: validated.ratePlan.cancellationPolicyText,
      rooms: quote.rooms,
      adults: validated.adults,
      nights: quote.nightly.map((night) => ({
        date: night.date.toISOString().slice(0, 10),
        basePrice: night.basePrice,
      })),
      taxRate: quote.taxRate,
      currency: quote.currency,
      subtotal: quote.subtotal,
      taxAmount: quote.taxAmount,
      discountAmount: quote.discountAmount,
      totalAmount: quote.totalAmount,
      quotedAt: quotedAt.toISOString(),
    };
  }

  /** Idempotent replay of an already-created booking. */
  private async replay(reservationId: string): Promise<BookingResponse> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: BOOKING_INCLUDE,
    });
    if (!reservation) {
      throw new NotFoundException('Booking not found');
    }
    return toBookingResponse(reservation);
  }

  /**
   * Looks a booking up by its customer-facing reference.
   *
   * A reservation number is a reference, not a secret, so ownership is checked
   * explicitly. A booking owned by someone else answers 404 rather than 403 —
   * a 403 would confirm the reference exists and turn this into an enumeration
   * oracle. Admin access will arrive as a separate role-guarded route rather
   * than a relaxation of this check.
   */
  async findByReference(
    userId: string,
    reference: string,
  ): Promise<BookingResponse> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { reservationNumber: reference },
      include: BOOKING_INCLUDE,
    });

    if (!reservation || reservation.userId !== userId) {
      throw new NotFoundException('Booking not found');
    }

    return toBookingResponse(reservation);
  }

  async listForUser(userId: string, query: ListBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ReservationWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [total, reservations] = await Promise.all([
      this.prisma.reservation.count({ where }),
      this.prisma.reservation.findMany({
        where,
        include: BOOKING_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      results: reservations.map(toBookingResponse),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    };
  }

  /**
   * Releases one expired hold.
   *
   * The reservation is locked and re-read inside the transaction before anything
   * changes. Without that, this job could act on a snapshot taken before a
   * concurrent payment confirmation and expire a booking that was just paid for.
   * Phase B's confirmation path takes this same lock, so the two serialize.
   *
   * @returns true when this call performed the expiry
   */
  async expireReservation(reservationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { status: ReservationStatus; holdExpiresAt: Date | null }[]
      >`
        SELECT "status", "holdExpiresAt"
        FROM "reservations"
        WHERE "id" = ${reservationId}::uuid
        FOR UPDATE
      `;

      const current = locked[0];
      if (!current) return false;

      const now = new Date();
      const stillExpirable =
        current.status === ReservationStatus.PAYMENT_PENDING &&
        current.holdExpiresAt !== null &&
        new Date(current.holdExpiresAt).getTime() <= now.getTime();

      // Another path (payment confirmation, cancellation, an earlier run of this
      // job) already moved it on. Leave it alone.
      if (!stillExpirable) return false;

      assertTransition(current.status, ReservationStatus.EXPIRED);

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.EXPIRED },
      });
      await this.inventory.releaseHolds(tx, reservationId);
      await tx.reservationStatusHistory.create({
        data: {
          reservationId,
          fromStatus: current.status,
          toStatus: ReservationStatus.EXPIRED,
          reason: 'HOLD_EXPIRED',
          actor: 'hold-expiry',
        },
      });

      return true;
    });
  }

  /** Candidate ids for expiry, read without locks; each is re-checked under one. */
  async findExpiredHoldCandidates(
    limit = 100,
    now: Date = new Date(),
  ): Promise<string[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.PAYMENT_PENDING,
        holdExpiresAt: { lt: now },
      },
      select: { id: true },
      orderBy: { holdExpiresAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  private isReservationNumberClash(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code !== 'P2002') return false;
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target);
    return fields.includes('reservationNumber');
  }
}
