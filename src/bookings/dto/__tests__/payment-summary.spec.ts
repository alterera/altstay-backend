import { PaymentStatus, ReservationStatus } from '../../../prisma/client';
import { PaymentRecord, selectPayment } from '../payment-summary';

function payment(
  overrides: Partial<PaymentRecord> & { paymentReference: string },
): PaymentRecord {
  return {
    status: PaymentStatus.PENDING,
    paidAt: null,
    refundRequired: false,
    failureReason: null,
    createdAt: new Date('2026-08-20T07:00:00.000Z'),
    ...overrides,
  };
}

describe('selectPayment', () => {
  it('returns null when there are no attempts', () => {
    expect(selectPayment(ReservationStatus.PAYMENT_PENDING, [])).toBeNull();
  });

  it('on a confirmed booking, exposes the earliest captured payment', () => {
    const failed = payment({
      paymentReference: 'PAY-1',
      status: PaymentStatus.FAILED,
      createdAt: new Date('2026-08-20T07:00:00.000Z'),
    });
    const captured = payment({
      paymentReference: 'PAY-2',
      status: PaymentStatus.CAPTURED,
      paidAt: new Date('2026-08-20T07:02:00.000Z'),
      createdAt: new Date('2026-08-20T07:01:00.000Z'),
    });
    const extra = payment({
      paymentReference: 'PAY-3',
      status: PaymentStatus.CAPTURED,
      refundRequired: true,
      paidAt: new Date('2026-08-20T07:05:00.000Z'),
      createdAt: new Date('2026-08-20T07:04:00.000Z'),
    });

    const summary = selectPayment(ReservationStatus.CONFIRMED, [
      extra,
      captured,
      failed,
    ]);

    expect(summary).toMatchObject({
      paymentReference: 'PAY-2',
      status: PaymentStatus.CAPTURED,
      refundRequired: false,
    });
    expect(summary).not.toHaveProperty('providerPaymentId');
  });

  it('while paying, prefers the live attempt over a previous failure', () => {
    const failed = payment({
      paymentReference: 'PAY-1',
      status: PaymentStatus.FAILED,
      failureReason: 'CARD_DECLINED',
      createdAt: new Date('2026-08-20T07:00:00.000Z'),
    });
    const live = payment({
      paymentReference: 'PAY-2',
      status: PaymentStatus.PENDING,
      createdAt: new Date('2026-08-20T07:01:00.000Z'),
    });

    expect(
      selectPayment(ReservationStatus.PAYMENT_PENDING, [failed, live]),
    ).toMatchObject({
      paymentReference: 'PAY-2',
      status: PaymentStatus.PENDING,
    });
  });

  it('while paying with no live attempt, shows the most recent failure', () => {
    const first = payment({
      paymentReference: 'PAY-1',
      status: PaymentStatus.FAILED,
      createdAt: new Date('2026-08-20T07:00:00.000Z'),
    });
    const second = payment({
      paymentReference: 'PAY-2',
      status: PaymentStatus.FAILED,
      failureReason: 'CARD_DECLINED',
      createdAt: new Date('2026-08-20T07:01:00.000Z'),
    });

    expect(
      selectPayment(ReservationStatus.PAYMENT_PENDING, [first, second]),
    ).toMatchObject({
      paymentReference: 'PAY-2',
      failureReason: 'CARD_DECLINED',
    });
  });

  it('on an expired booking, prefers a captured payment that needs a refund', () => {
    const failed = payment({
      paymentReference: 'PAY-1',
      status: PaymentStatus.FAILED,
      createdAt: new Date('2026-08-20T07:01:00.000Z'),
    });
    const owed = payment({
      paymentReference: 'PAY-2',
      status: PaymentStatus.CAPTURED,
      refundRequired: true,
      paidAt: new Date('2026-08-20T07:02:00.000Z'),
      createdAt: new Date('2026-08-20T07:00:00.000Z'),
    });

    expect(
      selectPayment(ReservationStatus.EXPIRED, [failed, owed]),
    ).toMatchObject({
      paymentReference: 'PAY-2',
      refundRequired: true,
    });
  });
});
