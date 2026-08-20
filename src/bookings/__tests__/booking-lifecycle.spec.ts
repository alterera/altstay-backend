import { ConflictException } from '@nestjs/common';
import { ReservationStatus } from '../../prisma/client';
import {
  ALLOWED_TRANSITIONS,
  HOLDING_STATUSES,
  assertTransition,
  canTransition,
} from '../booking-lifecycle';

describe('booking lifecycle', () => {
  it('allows the Phase A expiry edge', () => {
    expect(
      canTransition(
        ReservationStatus.PAYMENT_PENDING,
        ReservationStatus.EXPIRED,
      ),
    ).toBe(true);
  });

  it('allows the Phase B payment edges', () => {
    expect(
      canTransition(
        ReservationStatus.PAYMENT_PENDING,
        ReservationStatus.CONFIRMED,
      ),
    ).toBe(true);
    // A failed payment leaves the reservation PAYMENT_PENDING so the guest can
    // retry; CANCELLED is a separate, explicit path, not the failure outcome.
    expect(
      canTransition(
        ReservationStatus.PAYMENT_PENDING,
        ReservationStatus.CANCELLED,
      ),
    ).toBe(true);
    // Late payment may recover an expired hold after an inventory re-check.
    expect(
      canTransition(ReservationStatus.EXPIRED, ReservationStatus.CONFIRMED),
    ).toBe(true);
  });

  it.each([
    ReservationStatus.CANCELLED,
    ReservationStatus.COMPLETED,
    ReservationStatus.NO_SHOW,
  ])('treats %s as terminal', (status) => {
    expect(ALLOWED_TRANSITIONS[status]).toHaveLength(0);
  });

  it('does not treat EXPIRED as a catch-all resurrection', () => {
    expect(
      canTransition(
        ReservationStatus.EXPIRED,
        ReservationStatus.PAYMENT_PENDING,
      ),
    ).toBe(false);
    expect(() =>
      assertTransition(ReservationStatus.EXPIRED, ReservationStatus.EXPIRED),
    ).toThrow(ConflictException);
  });

  it('names the illegal edge in the error', () => {
    expect(() =>
      assertTransition(ReservationStatus.CONFIRMED, ReservationStatus.EXPIRED),
    ).toThrow('Illegal reservation transition CONFIRMED -> EXPIRED');
  });

  it('counts only PAYMENT_PENDING as holding inventory in Phase A', () => {
    expect(HOLDING_STATUSES).toEqual([ReservationStatus.PAYMENT_PENDING]);
  });
});
