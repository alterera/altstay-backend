import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Prisma, ReservationStatus } from '../prisma/client';
import { PricingClient } from '../pricing/pricing.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSessionResponse,
  PaymentServiceClient,
  PaymentServiceRejectedError,
} from './payment-service.client';
import { PaymentsConfig } from './payments.config';
import {
  LockedReservation,
  lockReservationByNumber,
  lockReservationById,
} from './reservation-lock';

export const PROVIDER_CASHFREE = 'CASHFREE';

/** Live attempt statuses — the set the one-per-reservation index guards. */
const LIVE_PAYMENT_STATUSES = [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED];

export type PaymentSessionResponse = {
  paymentReference: string;
  checkoutUrl: string;
  sessionExpiresAt: string | null;
  amount: string;
  currency: string;
  holdExpiresAt: string | null;
};

type PreparedAttempt = {
  reservationId: string;
  paymentId: string;
  paymentReference: string;
  amount: string;
  currency: string;
  holdExpiresAt: Date;
  customer: { name: string; phone?: string; email?: string };
};

/**
 * Turns a customer's Pay action into a checkout URL.
 *
 * The whole point of the three-phase split below is that the remote call to
 * pay.alterera.net happens between two short transactions rather than inside
 * one. Holding a reservation row lock across an external HTTP call would let a
 * slow provider stall hold expiry and serialise unrelated bookings behind it.
 *
 *   1. lock, validate, create or reuse a payment attempt, commit
 *   2. call the payment service with no locks held
 *   3. lock again, re-validate, and either publish the session or abort it
 *
 * Phase 3 exists because phase 2 takes real time: a confirmation or an expiry
 * can land while we are waiting, and we must not hand out a checkout URL for a
 * reservation that has since moved on.
 */
@Injectable()
export class PaymentSessionsService {
  private readonly logger = new Logger(PaymentSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PaymentServiceClient,
    private readonly config: PaymentsConfig,
  ) {}

  async createSession(
    userId: string,
    reference: string,
  ): Promise<PaymentSessionResponse> {
    const prepared = await this.prepareAttempt(userId, reference);

    let session: CreateSessionResponse;
    try {
      session = await this.client.createSession({
        paymentReference: prepared.paymentReference,
        reservationReference: reference,
        amount: prepared.amount,
        currency: prepared.currency,
        customer: prepared.customer,
        returnUrl: this.config.bookingResultUrl(reference),
        expiresAt: prepared.holdExpiresAt.toISOString(),
      });
    } catch (error) {
      // A rejection is the payment service's verdict on this reference, so the
      // attempt is dead and must not block the next one behind the live-attempt
      // index. A transport failure is ambiguous, so the row is left alone for a
      // bounded retry.
      if (error instanceof PaymentServiceRejectedError) {
        await this.failAttempt(
          prepared.paymentId,
          `PAYMENT_SERVICE_REJECTED: ${error.message}`,
        );
        throw new BadGatewayException(
          'The payment service could not start a checkout for this booking',
        );
      }
      throw error;
    }

    return this.publishOrAbort(prepared, session);
  }

  /** Phase 1: lock, validate, and settle on exactly one payment attempt. */
  private async prepareAttempt(
    userId: string,
    reference: string,
  ): Promise<PreparedAttempt> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await lockReservationByNumber(tx, reference);
      const now = new Date();

      // Ownership mismatch answers 404, matching findByReference: a 403 would
      // confirm the reference exists and turn this into an enumeration oracle.
      if (!reservation || reservation.userId !== userId) {
        throw new NotFoundException('Booking not found');
      }

      this.assertPayable(reservation, now);
      const holdExpiresAt = reservation.holdExpiresAt!;

      const existing = await tx.payment.findFirst({
        where: {
          reservationId: reservation.id,
          status: { in: LIVE_PAYMENT_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
      });

      const customer = await this.loadCustomer(tx, reservation.id);
      let payment = existing;

      if (existing) {
        const staleAt =
          existing.createdAt.getTime() + this.config.staleAttemptMs;
        const isStale = staleAt <= now.getTime();
        // Decimal comparison, not string: "8700" and "8700.00" are the same money.
        const amountChanged = !new Prisma.Decimal(
          reservation.totalAmountText,
        ).equals(existing.amount);

        if (isStale || amountChanged) {
          // Retire it in the same transaction, so the partial unique index is
          // free the moment we insert the replacement.
          await tx.payment.update({
            where: { id: existing.id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: isStale
                ? 'STALE_ATTEMPT_ABANDONED'
                : 'AMOUNT_CHANGED',
            },
          });
          payment = null;
        }
      }

      // A previous attempt that failed is never reused: the provider order tied
      // to it is spent, so a retry needs a brand new reference.
      payment ??= await tx.payment.create({
        data: {
          reservationId: reservation.id,
          provider: PROVIDER_CASHFREE,
          paymentReference: this.newPaymentReference(),
          amount: reservation.totalAmountText,
          currency: reservation.currency,
          status: PaymentStatus.PENDING,
        },
      });

      return {
        reservationId: reservation.id,
        paymentId: payment.id,
        paymentReference: payment.paymentReference,
        amount: reservation.totalAmountText,
        currency: reservation.currency,
        holdExpiresAt,
        customer,
      };
    });
  }

  /** Phase 3: re-lock and decide whether the freshly minted session is still usable. */
  private async publishOrAbort(
    prepared: PreparedAttempt,
    session: {
      checkoutUrl: string;
      providerOrderId: string;
      sessionExpiresAt: string | null;
    },
  ): Promise<PaymentSessionResponse> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const reservation = await lockReservationById(tx, prepared.reservationId);
      const now = new Date();

      const payment = await tx.payment.findUnique({
        where: { id: prepared.paymentId },
      });

      const stillEligible =
        reservation !== null &&
        payment !== null &&
        payment.status === PaymentStatus.PENDING &&
        this.isPayable(reservation, now);

      if (!stillEligible) {
        if (payment && payment.status === PaymentStatus.PENDING) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: 'SESSION_ABORTED_INELIGIBLE',
              providerOrderId: session.providerOrderId,
            },
          });
        }
        return { published: false as const, status: reservation?.status };
      }

      await tx.payment.update({
        where: { id: prepared.paymentId },
        data: { providerOrderId: session.providerOrderId },
      });

      return {
        published: true as const,
        holdExpiresAt: reservation.holdExpiresAt,
      };
    });

    if (!outcome.published) {
      // Committed the abort first, so the best-effort teardown cannot leave the
      // reservation half-decided if the payment service is unreachable.
      await this.client.cancelSession(prepared.paymentReference);
      this.logger.warn(
        `Aborted payment session ${prepared.paymentReference}: reservation is ${
          outcome.status ?? 'missing'
        }`,
      );
      throw new ConflictException(
        outcome.status === ReservationStatus.CONFIRMED
          ? 'This booking has already been paid for'
          : 'This booking is no longer holding its rooms. Please search again.',
      );
    }

    return {
      paymentReference: prepared.paymentReference,
      checkoutUrl: session.checkoutUrl,
      sessionExpiresAt: session.sessionExpiresAt,
      amount: prepared.amount,
      currency: prepared.currency,
      holdExpiresAt: outcome.holdExpiresAt?.toISOString() ?? null,
    };
  }

  private async failAttempt(paymentId: string, reason: string): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED, failureReason: reason },
    });
  }

  /**
   * Payable means PAYMENT_PENDING with enough hold left to finish a checkout.
   * The margin matters: a hold that lapses mid-payment produces a captured
   * payment with no room, which is a refund case rather than a booking.
   */
  private isPayable(reservation: LockedReservation, now: Date): boolean {
    if (reservation.status !== ReservationStatus.PAYMENT_PENDING) return false;
    if (!reservation.holdExpiresAt) return false;
    const marginMs = this.config.minHoldRemainingSeconds * 1000;
    return reservation.holdExpiresAt.getTime() - now.getTime() > marginMs;
  }

  private assertPayable(reservation: LockedReservation, now: Date): void {
    if (reservation.status === ReservationStatus.CONFIRMED) {
      throw new ConflictException('This booking has already been paid for');
    }
    if (reservation.status !== ReservationStatus.PAYMENT_PENDING) {
      throw new ConflictException(
        'This booking can no longer be paid for. Please search again.',
      );
    }
    if (!this.isPayable(reservation, now)) {
      throw new ConflictException(
        'The hold on these rooms is about to expire. Please search again.',
      );
    }
  }

  private async loadCustomer(
    tx: PricingClient,
    reservationId: string,
  ): Promise<{ name: string; phone?: string; email?: string }> {
    const guest = await tx.guest.findFirst({
      where: { reservationId },
      orderBy: { id: 'asc' },
    });

    const name = [guest?.firstName, guest?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      name: name || 'Guest',
      phone: guest?.phone ?? undefined,
      email: guest?.email ?? undefined,
    };
  }

  private newPaymentReference(): string {
    return `PAY-${crypto.randomUUID()}`;
  }
}
