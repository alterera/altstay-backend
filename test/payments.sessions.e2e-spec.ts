import { randomUUID } from 'node:crypto';
import { bookingOf, errorOf } from './helpers/booking-test-fixture';
import { PaymentFixture, sessionOf } from './helpers/payment-test-fixture';
import { PaymentStatus, ReservationStatus } from '../src/prisma/client';

/**
 * The session endpoint's job is to hand out a checkout URL without ever holding a
 * reservation lock across the call to the payment service. These specs pin both
 * halves: the happy path contract, and the behaviour when the world changes while
 * that external call is in flight.
 */
describe('POST /bookings/:reference/payment-session (e2e)', () => {
  const fixture = new PaymentFixture();

  beforeAll(async () => {
    // Ample inventory: these specs are about the session flow, not capacity, and
    // every case books a fresh reservation.
    await fixture.setup({
      totalRooms: 30,
      users: 2,
      nights: 2,
      nightlyRate: 1000,
    });
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  beforeEach(() => {
    fixture.paymentService.reset();
  });

  async function book(userIndex = 0) {
    const res = await fixture.postBooking(fixture.users[userIndex]);
    expect(res.status).toBe(201);
    return bookingOf(res);
  }

  describe('for a payable reservation', () => {
    it('returns a checkout URL and records a pending payment attempt', async () => {
      const booking = await book();

      const res = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(res.status).toBe(201);
      const body = sessionOf(res);
      expect(body.checkoutUrl).toContain('checkout.e2e.invalid');
      expect(body.paymentReference).toMatch(/^PAY-/);
      expect(body.amount).toBe(booking.totalAmount.toFixed(2));

      const payments = await fixture.paymentsFor(booking.reservationNumber);
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe(PaymentStatus.PENDING);
      expect(payments[0].providerOrderId).toBe(body.paymentReference);
    });

    it('sends the server-side total, never a client-supplied amount', async () => {
      const booking = await book();

      await fixture.postSession(fixture.users[0], booking.reservationNumber);

      const [sent] = fixture.paymentService.createCalls;
      expect(sent.amount).toBe(booking.totalAmount.toFixed(2));
      expect(sent.currency).toBe('INR');
      expect(sent.expiresAt).toBe(booking.holdExpiresAt);
      expect(sent.returnUrl).toContain(booking.reservationNumber);
    });

    it('reuses the live attempt when the customer presses Pay twice', async () => {
      const booking = await book();

      const first = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );
      const second = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(sessionOf(second).paymentReference).toBe(
        sessionOf(first).paymentReference,
      );
      expect(await fixture.paymentsFor(booking.reservationNumber)).toHaveLength(
        1,
      );
    });
  });

  describe('authorization', () => {
    it('answers 404 for another user, not 403', async () => {
      const booking = await book(0);

      const res = await fixture.postSession(
        fixture.users[1],
        booking.reservationNumber,
      );

      expect(res.status).toBe(404);
      expect(fixture.paymentService.createCalls).toHaveLength(0);
    });

    it('answers 404 for a reference that does not exist', async () => {
      const res = await fixture.postSession(
        fixture.users[0],
        'ALTSTAY-20260101-ZZZZZZ',
      );

      expect(res.status).toBe(404);
    });

    it('requires a token', async () => {
      const booking = await book();

      const res = await fixture.http.post(
        `/bookings/${booking.reservationNumber}/payment-session`,
      );

      expect(res.status).toBe(401);
    });
  });

  describe('when the reservation is no longer payable', () => {
    it('rejects an expired hold with 409 and does not call the provider', async () => {
      const booking = await book();
      await fixture.forceHoldExpiry(booking.reservationNumber);

      const res = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(res.status).toBe(409);
      expect(errorOf(res).message).toContain('expire');
      expect(fixture.paymentService.createCalls).toHaveLength(0);
    });

    it('rejects a confirmed booking as already paid', async () => {
      const booking = await book();
      await fixture.prisma.reservation.update({
        where: { reservationNumber: booking.reservationNumber },
        data: { status: ReservationStatus.CONFIRMED, holdExpiresAt: null },
      });

      const res = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(res.status).toBe(409);
      expect(errorOf(res).message).toContain('already been paid');
    });
  });

  describe('payment attempt lifecycle', () => {
    it('mints a new reference after a failed attempt rather than reusing it', async () => {
      const booking = await book();
      const first = sessionOf(
        await fixture.postSession(fixture.users[0], booking.reservationNumber),
      );

      // What a PAYMENT_FAILED notification leaves behind.
      await fixture.prisma.payment.update({
        where: { paymentReference: first.paymentReference },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: 'PROVIDER_REPORTED_FAILURE',
        },
      });

      const second = sessionOf(
        await fixture.postSession(fixture.users[0], booking.reservationNumber),
      );

      expect(second.paymentReference).not.toBe(first.paymentReference);
      const payments = await fixture.paymentsFor(booking.reservationNumber);
      expect(payments).toHaveLength(2);
      expect(payments.map((p) => p.status).sort()).toEqual([
        PaymentStatus.FAILED,
        PaymentStatus.PENDING,
      ]);
    });

    it('leaves the pending attempt reusable when the payment service is unreachable', async () => {
      const booking = await book();
      fixture.paymentService.failCreateWith = Object.assign(
        new Error('socket hang up'),
        { name: 'TypeError' },
      );

      const failed = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );
      expect(failed.status).toBeGreaterThanOrEqual(500);

      const afterFailure = await fixture.paymentsFor(booking.reservationNumber);
      expect(afterFailure).toHaveLength(1);
      expect(afterFailure[0].status).toBe(PaymentStatus.PENDING);

      fixture.paymentService.failCreateWith = undefined;
      const retry = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(retry.status).toBe(201);
      expect(sessionOf(retry).paymentReference).toBe(
        afterFailure[0].paymentReference,
      );
    });
  });

  describe('when the hold lapses during the external call', () => {
    /**
     * This is the reason for the three-phase split. The stub expires the hold
     * midway through the payment-service call — something that is only possible if
     * the hotel is not holding the reservation lock at that moment.
     */
    it('aborts the session, cancels it upstream, and answers 409', async () => {
      const booking = await book();

      fixture.paymentService.onCreate = async () => {
        await fixture.forceHoldExpiry(booking.reservationNumber);
      };

      const res = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(res.status).toBe(409);
      expect(fixture.paymentService.createCalls).toHaveLength(1);
      expect(fixture.paymentService.cancelCalls).toHaveLength(1);

      const payments = await fixture.paymentsFor(booking.reservationNumber);
      expect(payments[0].status).toBe(PaymentStatus.FAILED);
      expect(payments[0].failureReason).toBe('SESSION_ABORTED_INELIGIBLE');
    });

    it('lets an unrelated booking commit while a session call is in flight', async () => {
      const booking = await book();
      let sawConcurrentBooking = false;

      fixture.paymentService.onCreate = async () => {
        // A second guest taking the remaining room must not queue behind the
        // in-flight session call.
        const other = await fixture.postBooking(
          fixture.users[1],
          fixture.bookingBody(),
          randomUUID(),
        );
        sawConcurrentBooking = other.status === 201;
      };

      const res = await fixture.postSession(
        fixture.users[0],
        booking.reservationNumber,
      );

      expect(sawConcurrentBooking).toBe(true);
      expect(res.status).toBe(201);
    });
  });
});
