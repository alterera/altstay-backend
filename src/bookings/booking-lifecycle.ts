import { ConflictException } from '@nestjs/common';
import { ReservationStatus } from '../prisma/client';

/**
 * Every legal reservation status edge. Declared in full — including the Phase B
 * payment edges — so that adding `confirmPayment()` later is a change to one
 * service rather than a redefinition of the state machine.
 *
 * Phase A only ever walks PAYMENT_PENDING -> EXPIRED (hold expiry).
 *
 * Note there is no PAYMENT_FAILED status in `ReservationStatus`. A failed payment
 * leaves the reservation in PAYMENT_PENDING with its hold intact so the guest can
 * retry; only hold expiry moves it on.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  [ReservationStatus.PENDING]: [
    ReservationStatus.PAYMENT_PENDING,
    ReservationStatus.CANCELLED,
    ReservationStatus.EXPIRED,
  ],
  [ReservationStatus.PAYMENT_PENDING]: [
    ReservationStatus.CONFIRMED,
    ReservationStatus.CANCELLED,
    ReservationStatus.EXPIRED,
  ],
  [ReservationStatus.CONFIRMED]: [
    ReservationStatus.COMPLETED,
    ReservationStatus.CANCELLED,
    ReservationStatus.NO_SHOW,
  ],
  [ReservationStatus.CANCELLED]: [],
  // A payment can land after the hold lapsed. Recovering the booking is better for
  // the guest than refunding, but only when the rooms are re-verified as free —
  // `PaymentConfirmationService` is the sole caller and does that under lock.
  [ReservationStatus.EXPIRED]: [ReservationStatus.CONFIRMED],
  [ReservationStatus.COMPLETED]: [],
  [ReservationStatus.NO_SHOW]: [],
};

/** Statuses that consume inventory through an active `InventoryHold`. */
export const HOLDING_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.PAYMENT_PENDING,
];

export function canTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(
      `Illegal reservation transition ${from} -> ${to}`,
    );
  }
}
