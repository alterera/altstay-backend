import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { PaymentsConfig } from '../payments.config';

export const SIGNATURE_HEADER = 'x-alterera-signature';
export const TIMESTAMP_HEADER = 'x-alterera-timestamp';
export const EVENT_ID_HEADER = 'x-alterera-event-id';

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Authenticates pay.alterera.net calling into the hotel backend.
 *
 * This direction gets an HMAC rather than a bearer token because it moves money
 * and inventory: a leaked static token would stay replayable forever, whereas a
 * signature is bound to one body and one timestamp.
 *
 * The signed string is `${timestamp}.${rawBody}`. Including the timestamp is what
 * makes the skew check meaningful — without it in the digest, an attacker could
 * keep a captured body alive by rewriting the header.
 */
@Injectable()
export class ServiceSignatureGuard implements CanActivate {
  private readonly logger = new Logger(ServiceSignatureGuard.name);

  constructor(private readonly config: PaymentsConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.isNotificationVerificationConfigured) {
      // Failing closed matters more than convenience here: an unset secret must
      // never mean "accept anything".
      throw new ServiceUnavailableException(
        'Payment notifications are not configured on this environment',
      );
    }

    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const signature = this.header(req, SIGNATURE_HEADER);
    const timestamp = this.header(req, TIMESTAMP_HEADER);
    const eventId = this.header(req, EVENT_ID_HEADER);

    if (!signature || !timestamp || !eventId) {
      throw new UnauthorizedException('Missing payment notification signature');
    }

    this.assertFreshTimestamp(timestamp);

    const rawBody = req.rawBody;
    if (!rawBody) {
      // Only reachable if the app was bootstrapped without `rawBody: true`.
      this.logger.error(
        'Raw body unavailable; signature cannot be verified. Bootstrap with { rawBody: true }.',
      );
      throw new UnauthorizedException(
        'Payment notification could not be verified',
      );
    }

    const expected = createHmac('sha256', this.config.notificationSigningSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

    if (!this.matches(expected, signature)) {
      this.logger.warn(
        `Rejected payment notification ${eventId}: signature mismatch`,
      );
      throw new UnauthorizedException('Invalid payment notification signature');
    }

    return true;
  }

  private assertFreshTimestamp(timestamp: string): void {
    const sentAtSeconds = Number(timestamp);
    if (!Number.isFinite(sentAtSeconds)) {
      throw new UnauthorizedException(
        'Payment notification timestamp is not a number',
      );
    }

    const skewSeconds = Math.abs(Date.now() / 1000 - sentAtSeconds);
    if (skewSeconds > this.config.notificationMaxSkewSeconds) {
      throw new UnauthorizedException(
        'Payment notification timestamp is outside the accepted window',
      );
    }
  }

  private matches(expected: string, received: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    // timingSafeEqual throws on length mismatch, which would itself leak length.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private header(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
