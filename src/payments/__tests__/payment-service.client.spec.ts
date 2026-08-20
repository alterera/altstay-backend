import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreateSessionRequest,
  PaymentServiceClient,
  PaymentServiceRejectedError,
} from '../payment-service.client';
import { PaymentsConfig } from '../payments.config';

type FetchMock = jest.MockedFunction<typeof fetch>;

function configStub(overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    paymentServiceBaseUrl: 'https://pay.example.test',
    paymentServiceToken: 'svc-token',
    requestTimeoutMs: 5000,
    isPaymentServiceConfigured: true,
    ...overrides,
  } as PaymentsConfig;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const request: CreateSessionRequest = {
  paymentReference: 'PAY-1',
  reservationReference: 'ALTSTAY-20260820-AAAAAA',
  amount: '8700.00',
  currency: 'INR',
  customer: { name: 'Asif Khan', phone: '9876543210' },
  returnUrl: 'https://alterstays.test/booking/payment-result?ref=X',
  expiresAt: '2026-08-20T07:10:00.000Z',
};

describe('PaymentServiceClient', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when the payment service is not configured', () => {
    it('reports the feature unavailable instead of calling out', async () => {
      const client = new PaymentServiceClient(
        configStub({ isPaymentServiceConfigured: false }),
      );

      await expect(client.createSession(request)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('creating a session successfully', () => {
    it('sends the bearer token and returns the parsed session', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockResolvedValue(
        jsonResponse(201, {
          paymentReference: 'PAY-1',
          paymentSessionId: 'session_abc',
          providerOrderId: 'PAY-1',
          checkoutUrl: 'https://checkout.example.test/#session_abc',
          status: 'PENDING',
          sessionExpiresAt: '2026-08-20T07:10:00.000Z',
        }),
      );

      const result = await client.createSession(request);

      expect(result.checkoutUrl).toBe(
        'https://checkout.example.test/#session_abc',
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://pay.example.test/api/v1/payment-sessions');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer svc-token',
      );
      expect(JSON.parse(init.body as string)).toMatchObject({
        paymentReference: 'PAY-1',
        amount: '8700.00',
      });
    });

    it('keeps the amount a string so it cannot drift through a float', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockResolvedValue(jsonResponse(201, {}));

      await client.createSession({ ...request, amount: '8700.00' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body as string).toContain('"amount":"8700.00"');
    });
  });

  describe('when the payment service rejects the request', () => {
    it('surfaces the status and message rather than retrying', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockResolvedValue(
        jsonResponse(409, { message: 'Amount mismatch for PAY-1' }),
      );

      await expect(client.createSession(request)).rejects.toMatchObject({
        name: 'PaymentServiceRejectedError',
        status: 409,
        message: 'Amount mismatch for PAY-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to a generic message when the body is not JSON', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockResolvedValue(
        new Response('<html>gateway</html>', { status: 502 }),
      );

      await expect(client.createSession(request)).rejects.toBeInstanceOf(
        PaymentServiceRejectedError,
      );
    });
  });

  describe('when the transport fails', () => {
    it('maps a timeout to a bad gateway so the pending attempt survives', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), {
          name: 'TimeoutError',
        }),
      );

      await expect(client.createSession(request)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  describe('cancelling a session', () => {
    it('calls the cancel route with the reference', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 'EXPIRED' }));

      await client.cancelSession('PAY-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://pay.example.test/api/v1/payment-sessions/PAY-1/cancel',
      );
    });

    it('swallows failures because the hotel decision is already committed', async () => {
      const client = new PaymentServiceClient(configStub());
      fetchMock.mockRejectedValue(new Error('connection reset'));

      await expect(client.cancelSession('PAY-1')).resolves.toBeUndefined();
    });
  });
});
