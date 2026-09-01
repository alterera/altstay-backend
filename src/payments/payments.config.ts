import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SKEW_SECONDS = 300;
/** Cashfree requires order_expiry_time more than 15 minutes from checkout open. */
const DEFAULT_MIN_HOLD_REMAINING_SECONDS = 16 * 60;
const DEFAULT_STALE_ATTEMPT_MINUTES = 15;

/**
 * Every knob the payment integration reads, resolved once so the rest of the
 * module never touches `process.env` and never re-parses a number.
 *
 * Secrets are read but never logged. `assertConfigured` is deliberately a
 * runtime check rather than a bootstrap failure: Phase A booking flows must keep
 * working in an environment that has not been given payment credentials yet.
 */
@Injectable()
export class PaymentsConfig {
  private readonly logger = new Logger(PaymentsConfig.name);

  constructor(private readonly config: ConfigService) {}

  /** Base URL of pay.alterera.net, without a trailing slash. */
  get paymentServiceBaseUrl(): string {
    return (
      this.config
        .get<string>('PAYMENT_SERVICE_BASE_URL')
        ?.replace(/\/+$/, '') ?? ''
    );
  }

  /** Bearer token we send to the payment service. Outbound only. */
  get paymentServiceToken(): string {
    return this.config.get<string>('PAYMENT_SERVICE_TOKEN') ?? '';
  }

  /** Shared secret for verifying HMAC-signed notifications coming back to us. */
  get notificationSigningSecret(): string {
    return this.config.get<string>('PAYMENT_NOTIFICATION_SIGNING_SECRET') ?? '';
  }

  get requestTimeoutMs(): number {
    return this.positiveInt('PAYMENT_SERVICE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  }

  /** How far a notification timestamp may drift before we treat it as a replay. */
  get notificationMaxSkewSeconds(): number {
    return this.positiveInt(
      'PAYMENT_NOTIFICATION_MAX_SKEW_SECONDS',
      DEFAULT_MAX_SKEW_SECONDS,
    );
  }

  /**
   * Refuse to open checkout when the hold has less than this long to live.
   * Sending someone to a payment page that expires mid-transaction guarantees a
   * refund case.
   */
  get minHoldRemainingSeconds(): number {
    return this.positiveInt(
      'PAYMENT_SESSION_MIN_HOLD_REMAINING_SECONDS',
      DEFAULT_MIN_HOLD_REMAINING_SECONDS,
    );
  }

  /**
   * After this long, an untouched PENDING attempt is considered abandoned and a
   * new session request may replace it. Without this, a customer who closed the
   * tab mid-checkout would be blocked by the one-live-attempt index.
   */
  get staleAttemptMs(): number {
    return (
      this.positiveInt(
        'PAYMENT_ATTEMPT_STALE_MINUTES',
        DEFAULT_STALE_ATTEMPT_MINUTES,
      ) *
      60 *
      1000
    );
  }

  /** Where Cashfree returns the customer. The reference is a lookup key, not a secret. */
  bookingResultUrl(reservationReference: string): string {
    const base = this.config
      .get<string>('BOOKING_RESULT_URL')
      ?.replace(/\/+$/, '');
    if (!base) return '';
    return `${base}?ref=${encodeURIComponent(reservationReference)}`;
  }

  membershipResultUrl(purchaseId: string): string {
    const base = this.config
      .get<string>('MEMBERSHIP_RESULT_URL')
      ?.replace(/\/+$/, '');
    if (!base) {
      const bookingBase = this.config
        .get<string>('BOOKING_RESULT_URL')
        ?.replace(/\/bookings\/result.*$/, '');
      if (bookingBase) {
        return `${bookingBase}/membership/result?ref=${encodeURIComponent(purchaseId)}`;
      }
      return '';
    }
    return `${base}?ref=${encodeURIComponent(purchaseId)}`;
  }

  get isPaymentServiceConfigured(): boolean {
    return Boolean(this.paymentServiceBaseUrl && this.paymentServiceToken);
  }

  get isNotificationVerificationConfigured(): boolean {
    return Boolean(this.notificationSigningSecret);
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `${key}="${raw}" is not a positive number; using ${fallback}`,
      );
      return fallback;
    }
    return Math.floor(parsed);
  }
}
