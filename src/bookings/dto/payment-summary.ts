import { PaymentStatus, ReservationStatus } from '../../prisma/client';

export type PaymentRecord = {
  paymentReference: string;
  status: PaymentStatus;
  paidAt: Date | null;
  refundRequired: boolean;
  failureReason: string | null;
  createdAt: Date;
};

export type PaymentSummary = {
  status: PaymentStatus;
  paymentReference: string;
  paidAt: string | null;
  refundRequired: boolean;
  failureReason: string | null;
};

const LIVE: readonly PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.AUTHORIZED,
];

/**
 * Picks the one payment attempt a customer should see.
 *
 * A reservation accumulates a row per checkout attempt, so "the payment" needs a
 * rule rather than a guess. The rule follows what the guest needs to know: on a
 * confirmed booking, the money that paid for it; while paying, the attempt they
 * are in or the failure they should retry from; on a dead booking, whether they
 * are owed a refund.
 *
 * Provider identifiers are deliberately not part of the summary — the browser has
 * no use for them and they are a support-surface leak.
 */
export function selectPayment(
  reservationStatus: ReservationStatus,
  payments: PaymentRecord[],
): PaymentSummary | null {
  if (!payments.length) return null;

  const newestFirst = [...payments].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const captured = newestFirst.filter(
    (payment) => payment.status === PaymentStatus.CAPTURED,
  );

  switch (reservationStatus) {
    case ReservationStatus.CONFIRMED:
    case ReservationStatus.COMPLETED:
    case ReservationStatus.NO_SHOW: {
      // If more than one capture exists, the earliest is the one that bought the
      // booking; the rest are refund cases.
      const paying = captured.length
        ? captured[captured.length - 1]
        : newestFirst[0];
      return toSummary(paying);
    }

    case ReservationStatus.PAYMENT_PENDING:
    case ReservationStatus.PENDING: {
      const live = newestFirst.find((payment) => LIVE.includes(payment.status));
      return toSummary(live ?? newestFirst[0]);
    }

    case ReservationStatus.EXPIRED:
    case ReservationStatus.CANCELLED: {
      const owed = captured.find((payment) => payment.refundRequired);
      return toSummary(owed ?? newestFirst[0]);
    }
  }
}

function toSummary(payment: PaymentRecord): PaymentSummary {
  return {
    status: payment.status,
    paymentReference: payment.paymentReference,
    paidAt: payment.paidAt?.toISOString() ?? null,
    refundRequired: payment.refundRequired,
    failureReason: payment.failureReason,
  };
}
