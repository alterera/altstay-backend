import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentsConfig } from './payments.config';

export type CreateSessionRequest = {
  paymentReference: string;
  reservationReference: string;
  /** Decimal string, never a float — the hotel side is the amount authority. */
  amount: string;
  currency: string;
  customer: {
    name: string;
    phone?: string;
    email?: string;
  };
  returnUrl: string;
  /** The reservation's holdExpiresAt, so the provider order cannot outlive the hold. */
  expiresAt: string;
};

export type CreateSessionResponse = {
  paymentReference: string;
  paymentSessionId: string;
  providerOrderId: string;
  checkoutUrl: string;
  status: string;
  sessionExpiresAt: string | null;
};

/**
 * Thrown when the payment service answered, but rejected the request. Distinct
 * from a transport failure because a 4xx means retrying the same body is
 * pointless.
 */
export class PaymentServiceRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentServiceRejectedError';
  }
}

/**
 * Talks to pay.alterera.net.
 *
 * Every call here runs outside any database transaction — see
 * `PaymentSessionsService` for why. The timeout is therefore about customer
 * latency, not lock duration.
 */
@Injectable()
export class PaymentServiceClient {
  private readonly logger = new Logger(PaymentServiceClient.name);

  constructor(private readonly config: PaymentsConfig) {}

  async createSession(
    body: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>(
      'POST',
      '/api/v1/payment-sessions',
      body,
    );
  }

  /**
   * Best-effort teardown of a session the hotel can no longer honour.
   *
   * Never throws: the reservation-side decision has already been committed, and
   * Cashfree may legitimately refuse to terminate an order whose transaction has
   * just succeeded. That case resolves through the late-payment path instead.
   */
  async cancelSession(paymentReference: string): Promise<void> {
    try {
      await this.request<unknown>(
        'POST',
        `/api/v1/payment-sessions/${encodeURIComponent(paymentReference)}/cancel`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not cancel payment session ${paymentReference}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.config.isPaymentServiceConfigured) {
      throw new ServiceUnavailableException(
        'Online payment is not configured on this environment',
      );
    }

    const url = `${this.config.paymentServiceBaseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.paymentServiceToken}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      // Timeout, DNS, refused connection: the request may or may not have been
      // seen. Callers treat this as retryable and leave their PENDING row alone.
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`${method} ${path} failed in transport: ${reason}`);
      throw new BadGatewayException('The payment service is unreachable');
    }

    const payload = await this.readJson(response);

    if (!response.ok) {
      const message = this.errorMessage(payload);
      this.logger.error(
        `${method} ${path} rejected with ${response.status}: ${message}`,
      );
      throw new PaymentServiceRejectedError(response.status, message);
    }

    return payload as T;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 500) };
    }
  }

  private errorMessage(payload: unknown): string {
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = payload.message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join(', ');
    }
    return 'The payment service rejected the request';
  }
}
