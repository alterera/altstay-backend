import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentsConfig } from '../payments.config';
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  ServiceSignatureGuard,
  TIMESTAMP_HEADER,
} from '../guards/service-signature.guard';

const SECRET = 'test-signing-secret';

function configStub(overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    notificationSigningSecret: SECRET,
    notificationMaxSkewSeconds: 300,
    isNotificationVerificationConfigured: true,
    ...overrides,
  } as PaymentsConfig;
}

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as never;
}

function signedRequest(
  body: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const rawBody = Buffer.from(body, 'utf8');
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');

  return {
    headers: {
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
      [EVENT_ID_HEADER]: 'evt_1',
    },
    rawBody,
  };
}

describe('ServiceSignatureGuard', () => {
  it('accepts a fresh, correctly signed body', () => {
    const guard = new ServiceSignatureGuard(configStub());
    expect(guard.canActivate(contextFor(signedRequest('{"ok":true}')))).toBe(
      true,
    );
  });

  it('rejects a body that changed after signing', () => {
    const guard = new ServiceSignatureGuard(configStub());
    const req = signedRequest('{"amount":"8700.00"}');
    req.rawBody = Buffer.from('{"amount":"1.00"}', 'utf8');

    expect(() => guard.canActivate(contextFor(req))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong secret', () => {
    const guard = new ServiceSignatureGuard(
      configStub({
        notificationSigningSecret: 'other-secret',
      }),
    );
    expect(() =>
      guard.canActivate(contextFor(signedRequest('{"ok":true}'))),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a stale timestamp', () => {
    const guard = new ServiceSignatureGuard(configStub());
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() =>
      guard.canActivate(contextFor(signedRequest('{"ok":true}', stale))),
    ).toThrow(UnauthorizedException);
  });

  it('rejects missing headers', () => {
    const guard = new ServiceSignatureGuard(configStub());
    expect(() =>
      guard.canActivate(
        contextFor({ headers: {}, rawBody: Buffer.from('{}') }),
      ),
    ).toThrow(UnauthorizedException);
  });
});
