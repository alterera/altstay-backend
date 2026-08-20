import { Injectable, Logger } from '@nestjs/common';
import { eachNight } from '../admin/admin.utils';
import { BookingInventoryService } from '../bookings/booking-inventory.service';
import { assertTransition } from '../bookings/booking-lifecycle';
import { toUtcDateString } from '../bookings/booking.utils';
import { PricingClient } from '../pricing/pricing.types';
import {
  Payment,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentNotificationDto } from './dto/payment-notification.dto';
import {
  LockedReservation,
  isHoldLive,
  lockReservationByNumber,
} from './reservation-lock';

/** Provider name recorded on webhook events that came from our own payment service. */
export const NOTIFICATION_PROVIDER = 'ALTERERA_PAY';

const ACTOR = 'payment-service';

/**
 * A PROCESSING claim older than this is assumed to belong to a crashed attempt
 * and may be taken over. Without it, one crash mid-transaction would wedge a
 * payment behind permanent 409s.
 */
const CLAIM_TAKEOVER_MS = 60_000;

export type NotificationResult = {
  httpStatus: 200 | 202 | 409 | 422;
  body: {
    reservationStatus?: ReservationStatus;
    paymentStatus?: PaymentStatus;
    refundRequired?: boolean;
    duplicate: boolean;
    message?: string;
  };
};

type Outcome = Omit<NotificationResult, 'body'> & {
  body: Omit<NotificationResult['body'], 'duplicate'>;
};

/**
 * Applies a verified payment outcome to a reservation.
 *
 * Two properties make this safe to call repeatedly and concurrently:
 *
 * - every decision is taken while holding the reservation's `FOR UPDATE` lock,
 *   the same lock hold expiry takes, so confirmation and expiry can never both
 *   win; and
 * - the terminal HTTP answer is persisted on the webhook event row, so a
 *   redelivery replays the original answer instead of recomputing one against
 *   state that has since moved.
 */
@Injectable()
export class PaymentConfirmationService {
  private readonly logger = new Logger(PaymentConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: BookingInventoryService,
  ) {}

  async handleNotification(
    dto: PaymentNotificationDto,
  ): Promise<NotificationResult> {
    const claim = await this.claim(dto);

    if (claim.kind === 'REPLAY') {
      return {
        httpStatus: claim.httpStatus,
        body: { ...claim.body, duplicate: true },
      };
    }
    if (claim.kind === 'IN_FLIGHT') {
      // Deliberately not an error: the sender should simply come back later,
      // once the first delivery has committed an answer worth replaying.
      return {
        httpStatus: 409,
        body: {
          duplicate: true,
          message: 'This event is still being processed',
        },
      };
    }

    const outcome = await this.process(dto, claim.eventRowId);
    return {
      httpStatus: outcome.httpStatus,
      body: { ...outcome.body, duplicate: false },
    };
  }

  /**
   * Claim-first idempotency, the same pattern as booking creation: let the unique
   * index decide the winner rather than a read-then-write check, which two
   * concurrent deliveries would both pass.
   */
  private async claim(
    dto: PaymentNotificationDto,
  ): Promise<
    | { kind: 'CLAIMED'; eventRowId: string }
    | { kind: 'IN_FLIGHT' }
    | ({ kind: 'REPLAY' } & NotificationResult)
  > {
    try {
      const created = await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: NOTIFICATION_PROVIDER,
          providerEventId: dto.eventId,
          eventType: dto.eventType,
          processingStatus: 'PROCESSING',
          payload: dto as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { kind: 'CLAIMED', eventRowId: created.id };
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.paymentWebhookEvent.findUnique({
      where: {
        provider_providerEventId: {
          provider: NOTIFICATION_PROVIDER,
          providerEventId: dto.eventId,
        },
      },
    });

    if (existing?.processedAt && existing.responseStatus) {
      return {
        kind: 'REPLAY',
        httpStatus: existing.responseStatus as NotificationResult['httpStatus'],
        body: (existing.responsePayload ?? {}) as NotificationResult['body'],
      };
    }

    const stalled =
      existing !== null &&
      existing.receivedAt.getTime() + CLAIM_TAKEOVER_MS <= Date.now();

    if (stalled) {
      this.logger.warn(
        `Taking over stalled claim for event ${dto.eventId}; re-processing`,
      );
      return { kind: 'CLAIMED', eventRowId: existing.id };
    }

    return { kind: 'IN_FLIGHT' };
  }

  private async process(
    dto: PaymentNotificationDto,
    eventRowId: string,
  ): Promise<Outcome> {
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const reservation = await lockReservationByNumber(
          tx,
          dto.reservationReference,
        );

        const outcome = reservation
          ? await this.decide(tx, dto, reservation, now)
          : this.reject(`Unknown reservation ${dto.reservationReference}`);

        // Recorded in the same transaction as the mutation it describes, so a
        // committed state change always has a replayable answer attached.
        await tx.paymentWebhookEvent.update({
          where: { id: eventRowId },
          data: {
            processingStatus:
              outcome.httpStatus === 422 ? 'REJECTED' : 'PROCESSED',
            processingError: outcome.body.message ?? null,
            responseStatus: outcome.httpStatus,
            responsePayload: {
              ...outcome.body,
              duplicate: false,
            },
            processedAt: now,
          },
        });

        return outcome;
      },
      { timeout: 20_000, maxWait: 15_000 },
    );
  }

  private async decide(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    now: Date,
  ): Promise<Outcome> {
    const payment = await tx.payment.findUnique({
      where: { paymentReference: dto.paymentReference },
    });

    if (!payment || payment.reservationId !== reservation.id) {
      return this.reject(
        `Payment ${dto.paymentReference} does not belong to ${dto.reservationReference}`,
      );
    }
    if (
      !new Prisma.Decimal(dto.amount).equals(payment.amount) ||
      dto.currency !== payment.currency
    ) {
      return this.reject(
        `Amount mismatch for ${dto.paymentReference}: expected ` +
          `${payment.amount.toFixed(2)} ${payment.currency}`,
      );
    }

    if (dto.eventType === 'PAYMENT_FAILED') {
      return this.applyFailure(tx, dto, reservation, payment);
    }
    return this.applySuccess(tx, dto, reservation, payment, now);
  }

  /**
   * A failed payment does not touch the reservation. The hold stays live so the
   * guest can retry inside the time they were promised; only expiry moves it on.
   */
  private async applyFailure(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    payment: Payment,
  ): Promise<Outcome> {
    if (payment.status === PaymentStatus.CAPTURED) {
      // Out-of-order delivery: success already settled this payment. Money in
      // hand beats a later failure report, so nothing changes.
      this.logger.warn(
        `Ignoring failure for already-captured payment ${dto.paymentReference}`,
      );
      return this.ok(reservation.status, PaymentStatus.CAPTURED);
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        failureReason: dto.failureReason ?? 'PROVIDER_REPORTED_FAILURE',
        providerPaymentId: dto.providerPaymentId ?? payment.providerPaymentId,
        paymentMethod: dto.paymentMethod ?? payment.paymentMethod,
      },
    });

    return this.ok(reservation.status, PaymentStatus.FAILED);
  }

  private async applySuccess(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    payment: Payment,
    now: Date,
  ): Promise<Outcome> {
    if (reservation.status === ReservationStatus.CONFIRMED) {
      const alreadyThisPayment = payment.status === PaymentStatus.CAPTURED;
      if (alreadyThisPayment) {
        return this.ok(ReservationStatus.CONFIRMED, PaymentStatus.CAPTURED);
      }
      // A second, different payment succeeded for a booking already paid for.
      return this.captureForRefund(
        tx,
        dto,
        payment,
        reservation.status,
        'DUPLICATE_PAYMENT',
      );
    }

    const confirmable =
      reservation.status === ReservationStatus.PAYMENT_PENDING ||
      reservation.status === ReservationStatus.EXPIRED;

    if (!confirmable) {
      return this.reject(
        `Reservation ${dto.reservationReference} is ${reservation.status} and cannot be confirmed`,
      );
    }

    if (payment.status === PaymentStatus.FAILED) {
      // The guest retried after this attempt was written off, and the abandoned
      // attempt settled anyway. Confirming here could double-charge them.
      return this.captureForRefund(
        tx,
        dto,
        payment,
        reservation.status,
        'LATE_SUCCESS_ON_FAILED_ATTEMPT',
      );
    }

    const holds = await tx.inventoryHold.count({
      where: { reservationId: reservation.id },
    });

    // The status alone is not enough. Availability stops counting a hold the
    // moment its timestamp passes, well before the expiry job rewrites the
    // reservation, so a PAYMENT_PENDING row can already have lost its rooms.
    const onTime =
      reservation.status === ReservationStatus.PAYMENT_PENDING &&
      isHoldLive(reservation, now) &&
      holds > 0;

    return onTime
      ? this.confirmFromHolds(tx, dto, reservation, payment, now)
      : this.confirmFromItems(tx, dto, reservation, payment, now);
  }

  /** On-time path: the hold already reserves the capacity, so just convert it. */
  private async confirmFromHolds(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    payment: Payment,
    now: Date,
  ): Promise<Outcome> {
    await this.inventory.convertHoldsToSold(tx, reservation.id);
    await this.markConfirmed(
      tx,
      dto,
      reservation,
      payment,
      now,
      'ON_TIME_PAYMENT',
    );
    return this.ok(ReservationStatus.CONFIRMED, PaymentStatus.CAPTURED);
  }

  /**
   * Late path: the hold is gone, so capacity is re-derived from
   * `reservation_items` and re-checked under fresh inventory locks. The hold rows
   * cannot be used here — expiry may have deleted them, and availability ignores
   * them once expired.
   */
  private async confirmFromItems(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    payment: Payment,
    now: Date,
  ): Promise<Outcome> {
    const items = await tx.reservationItem.findMany({
      where: { reservationId: reservation.id },
      orderBy: { roomTypeId: 'asc' },
    });

    if (!items.length) {
      return this.reject(
        `Reservation ${dto.reservationReference} has no items to confirm`,
      );
    }

    const needs = items.map((item) => ({
      roomTypeId: item.roomTypeId,
      quantity: item.quantity,
      nights: eachNight(
        toUtcDateString(item.checkIn),
        toUtcDateString(item.checkOut),
      ),
    }));

    for (const need of needs) {
      const { nights, missingDates } =
        await this.inventory.lockAndLoadAvailability(
          tx,
          need.roomTypeId,
          need.nights,
          now,
        );

      const short =
        missingDates.length > 0 ||
        nights.some((night) => night.freeRooms < need.quantity);

      if (short) {
        this.logger.warn(
          `Late payment ${dto.paymentReference} cannot be honoured: ` +
            `no capacity for ${dto.reservationReference}`,
        );
        return this.captureForRefund(
          tx,
          dto,
          payment,
          reservation.status,
          'NO_INVENTORY_AT_CONFIRMATION',
        );
      }
    }

    for (const need of needs) {
      await this.inventory.sellRooms(
        tx,
        need.roomTypeId,
        need.nights,
        need.quantity,
      );
    }
    // Any leftover expired holds would otherwise double-count once the reservation
    // is back in a holding-adjacent state.
    await this.inventory.releaseHolds(tx, reservation.id);

    await this.markConfirmed(
      tx,
      dto,
      reservation,
      payment,
      now,
      'LATE_PAYMENT',
    );
    return this.ok(ReservationStatus.CONFIRMED, PaymentStatus.CAPTURED);
  }

  private async markConfirmed(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    reservation: LockedReservation,
    payment: Payment,
    now: Date,
    reason: string,
  ): Promise<void> {
    assertTransition(reservation.status, ReservationStatus.CONFIRMED);

    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        status: ReservationStatus.CONFIRMED,
        confirmedAt: now,
        holdExpiresAt: null,
      },
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CAPTURED,
        providerPaymentId: dto.providerPaymentId ?? payment.providerPaymentId,
        providerOrderId: dto.providerOrderId ?? payment.providerOrderId,
        paymentMethod: dto.paymentMethod ?? payment.paymentMethod,
        paidAt: new Date(dto.occurredAt),
        failureReason: null,
      },
    });

    await this.recordHistory(
      tx,
      reservation,
      ReservationStatus.CONFIRMED,
      reason,
      {
        paymentReference: dto.paymentReference,
        eventId: dto.eventId,
      },
    );
  }

  /**
   * Money arrived that we cannot turn into a booking. Recording it as captured
   * with `refundRequired` is the honest state: pretending the payment failed
   * would lose the fact that the guest was charged.
   */
  private async captureForRefund(
    tx: PricingClient,
    dto: PaymentNotificationDto,
    payment: Payment,
    reservationStatus: ReservationStatus,
    reason: string,
  ): Promise<Outcome> {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CAPTURED,
        providerPaymentId: dto.providerPaymentId ?? payment.providerPaymentId,
        providerOrderId: dto.providerOrderId ?? payment.providerOrderId,
        paymentMethod: dto.paymentMethod ?? payment.paymentMethod,
        paidAt: new Date(dto.occurredAt),
        refundRequired: true,
        refundReason: reason,
      },
    });

    return {
      httpStatus: 202,
      body: {
        reservationStatus,
        paymentStatus: PaymentStatus.CAPTURED,
        refundRequired: true,
        message: reason,
      },
    };
  }

  private async recordHistory(
    tx: PricingClient,
    reservation: LockedReservation,
    toStatus: ReservationStatus,
    reason: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.reservationStatusHistory.create({
      data: {
        reservationId: reservation.id,
        fromStatus: reservation.status,
        toStatus,
        reason,
        actor: ACTOR,
        metadata,
      },
    });
  }

  private ok(
    reservationStatus: ReservationStatus,
    paymentStatus: PaymentStatus,
  ): Outcome {
    return {
      httpStatus: 200,
      body: { reservationStatus, paymentStatus, refundRequired: false },
    };
  }

  /** 422 means "stop retrying and get a human to look", never "try again". */
  private reject(message: string): Outcome {
    this.logger.error(`Rejecting payment notification: ${message}`);
    return { httpStatus: 422, body: { message } };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
