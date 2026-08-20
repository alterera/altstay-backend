import { createHmac, randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import request from 'supertest';
import { PaymentServiceClient } from '../../src/payments/payment-service.client';
import type { CreateSessionRequest } from '../../src/payments/payment-service.client';
import {
  BookingFixture,
  BookingFixtureOptions,
  TestUser,
} from './booking-test-fixture';

export type SessionBody = {
  paymentReference: string;
  checkoutUrl: string;
  sessionExpiresAt: string | null;
  amount: string;
  currency: string;
  holdExpiresAt: string | null;
};

export type NotificationBody = {
  reservationStatus?: string;
  paymentStatus?: string;
  refundRequired?: boolean;
  duplicate: boolean;
  message?: string;
};

export function sessionOf(res: Response): SessionBody {
  return res.body as SessionBody;
}

export function notificationOf(res: Response): NotificationBody {
  return res.body as NotificationBody;
}

/**
 * A stand-in for pay.alterera.net.
 *
 * The suites need to control what the payment service does — succeed, stall, or
 * reject — without a second process, and they need to observe what the hotel sent
 * it. Overriding the client rather than mocking `fetch` keeps the assertions on
 * the contract in section 5.2 instead of on HTTP plumbing.
 */
export class StubPaymentService {
  readonly createCalls: CreateSessionRequest[] = [];
  readonly cancelCalls: string[] = [];

  /** Runs while the hotel is waiting on the session call, i.e. with no locks held. */
  onCreate?: () => Promise<void>;
  failCreateWith?: Error;

  async createSession(body: CreateSessionRequest) {
    this.createCalls.push(body);
    if (this.onCreate) await this.onCreate();
    if (this.failCreateWith) throw this.failCreateWith;

    return {
      paymentReference: body.paymentReference,
      paymentSessionId: `session_${body.paymentReference}`,
      providerOrderId: body.paymentReference,
      checkoutUrl: `https://checkout.e2e.invalid/#session_${body.paymentReference}`,
      status: 'PENDING',
      sessionExpiresAt: body.expiresAt,
    };
  }

  async cancelSession(paymentReference: string) {
    this.cancelCalls.push(paymentReference);
    await Promise.resolve();
  }

  reset(): void {
    this.createCalls.length = 0;
    this.cancelCalls.length = 0;
    this.onCreate = undefined;
    this.failCreateWith = undefined;
  }
}

export type NotificationOverrides = {
  eventId?: string;
  eventType?: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';
  amount?: string;
  currency?: string;
  providerPaymentId?: string;
  failureReason?: string | null;
  occurredAt?: string;
};

/**
 * Booking fixture plus everything the payment suites need: a stubbed payment
 * service and a correctly signed notification sender.
 */
export class PaymentFixture extends BookingFixture {
  readonly paymentService = new StubPaymentService();

  private readonly eventIds = new Set<string>();

  async setup(options: BookingFixtureOptions = {}): Promise<void> {
    await super.setup(options);
    // Swap the real client after boot so the module graph stays untouched.
    const client = this.app.get(PaymentServiceClient);
    Object.assign(client, {
      createSession: (body: CreateSessionRequest) =>
        this.paymentService.createSession(body),
      cancelSession: (reference: string) =>
        this.paymentService.cancelSession(reference),
    });
  }

  get signingSecret(): string {
    return process.env.PAYMENT_NOTIFICATION_SIGNING_SECRET!;
  }

  postSession(user: TestUser, reference: string) {
    return request(this.app.getHttpServer())
      .post(`/bookings/${reference}/payment-session`)
      .set('Authorization', `Bearer ${user.token}`)
      .send();
  }

  getBooking(user: TestUser, reference: string) {
    return request(this.app.getHttpServer())
      .get(`/bookings/${reference}`)
      .set('Authorization', `Bearer ${user.token}`);
  }

  notificationBody(
    reservationReference: string,
    paymentReference: string,
    amount: string,
    overrides: NotificationOverrides = {},
  ) {
    const eventId = overrides.eventId ?? `evt_${randomUUID()}`;
    this.eventIds.add(eventId);

    return {
      eventId,
      eventType: overrides.eventType ?? 'PAYMENT_SUCCEEDED',
      paymentReference,
      reservationReference,
      provider: 'CASHFREE',
      providerOrderId: paymentReference,
      providerPaymentId: overrides.providerPaymentId ?? `cf_${randomUUID()}`,
      amount: overrides.amount ?? amount,
      currency: overrides.currency ?? 'INR',
      paymentMethod: 'upi',
      occurredAt: overrides.occurredAt ?? new Date().toISOString(),
      failureReason: overrides.failureReason ?? null,
    };
  }

  /** Signs exactly the bytes that will be sent, which is what the guard verifies. */
  postNotification(
    body: Record<string, unknown>,
    tamper: { secret?: string; timestamp?: string; signature?: string } = {},
  ) {
    const raw = JSON.stringify(body);
    const timestamp = tamper.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature =
      tamper.signature ??
      createHmac('sha256', tamper.secret ?? this.signingSecret)
        .update(`${timestamp}.${raw}`)
        .digest('hex');

    return request(this.app.getHttpServer())
      .post('/internal/payments/notifications')
      .set('Content-Type', 'application/json')
      .set('X-Alterera-Event-Id', String(body.eventId))
      .set('X-Alterera-Timestamp', timestamp)
      .set('X-Alterera-Signature', signature)
      .send(raw);
  }

  async paymentsFor(reservationNumber: string) {
    return this.prisma.payment.findMany({
      where: { reservation: { reservationNumber } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async webhookEvent(eventId: string) {
    return this.prisma.paymentWebhookEvent.findUnique({
      where: {
        provider_providerEventId: {
          provider: 'ALTERERA_PAY',
          providerEventId: eventId,
        },
      },
    });
  }

  async inventoryForFixture() {
    return this.prisma.roomInventory.findMany({
      where: { roomTypeId: this.roomTypeId },
      orderBy: { date: 'asc' },
    });
  }

  async teardown(): Promise<void> {
    if (this.prisma && this.eventIds.size) {
      await this.prisma.paymentWebhookEvent.deleteMany({
        where: { providerEventId: { in: [...this.eventIds] } },
      });
    }
    await super.teardown();
  }
}
