import { createHmac } from 'node:crypto';
import { bookingOf } from './helpers/booking-test-fixture';
import {
  PaymentFixture,
  notificationOf,
  sessionOf,
} from './helpers/payment-test-fixture';
import { PaymentStatus, ReservationStatus } from '../src/prisma/client';

/**
 * The confirmation path is where money meets inventory, so these specs are the
 * ones that matter most. They cover the whole decision tree: on-time conversion,
 * the two late-payment shapes, duplicate delivery, failure, and the race against
 * hold expiry.
 */
describe('POST /internal/payments/notifications (e2e)', () => {
  const fixture = new PaymentFixture();

  beforeAll(async () => {
    await fixture.setup({
      totalRooms: 1,
      users: 2,
      nights: 2,
      nightlyRate: 1000,
    });
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  beforeEach(async () => {
    fixture.paymentService.reset();
    await resetInventory();
  });

  /** Each case starts from a clean sheet so capacity assertions mean something. */
  async function resetInventory() {
    await fixture.prisma.payment.deleteMany({
      where: { reservation: { propertyId: fixture.propertyId } },
    });
    await fixture.prisma.reservation.deleteMany({
      where: { propertyId: fixture.propertyId },
    });
    await fixture.prisma.roomInventory.updateMany({
      where: { roomTypeId: fixture.roomTypeId },
      data: { soldRooms: 0, blockedRooms: 0, totalRooms: 1 },
    });
  }

  async function bookAndStartPayment(userIndex = 0) {
    const booking = bookingOf(
      await fixture.postBooking(fixture.users[userIndex]),
    );
    const session = sessionOf(
      await fixture.postSession(
        fixture.users[userIndex],
        booking.reservationNumber,
      ),
    );
    return { booking, session };
  }

  async function soldPerNight() {
    const rows = await fixture.inventoryForFixture();
    return rows.map((row) => row.soldRooms);
  }

  describe('on-time success, hold still live', () => {
    it('confirms the reservation and turns the hold into sold rooms', async () => {
      const { booking, session } = await bookAndStartPayment();
      const body = fixture.notificationBody(
        booking.reservationNumber,
        session.paymentReference,
        session.amount,
      );

      const res = await fixture.postNotification(body);

      expect(res.status).toBe(200);
      expect(notificationOf(res)).toMatchObject({
        reservationStatus: ReservationStatus.CONFIRMED,
        paymentStatus: PaymentStatus.CAPTURED,
        duplicate: false,
      });

      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).toBe(ReservationStatus.CONFIRMED);
      expect(reservation?.confirmedAt).not.toBeNull();
      expect(reservation?.holdExpiresAt).toBeNull();
      // Holds are consumed, not merely deleted: capacity never becomes free.
      expect(reservation?.inventoryHolds).toHaveLength(0);
      expect(await soldPerNight()).toEqual([1, 1]);
    });

    it('writes an audit row for the transition', async () => {
      const { booking, session } = await bookAndStartPayment();

      await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      const history = await fixture.prisma.reservationStatusHistory.findMany({
        where: {
          reservation: { reservationNumber: booking.reservationNumber },
        },
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: ReservationStatus.PAYMENT_PENDING,
        toStatus: ReservationStatus.CONFIRMED,
        reason: 'ON_TIME_PAYMENT',
        actor: 'payment-service',
      });
    });
  });

  describe('duplicate delivery', () => {
    it('replays the stored response verbatim instead of mutating again', async () => {
      const { booking, session } = await bookAndStartPayment();
      const body = fixture.notificationBody(
        booking.reservationNumber,
        session.paymentReference,
        session.amount,
      );

      const first = await fixture.postNotification(body);
      const second = await fixture.postNotification(body);

      expect(second.status).toBe(first.status);
      expect(notificationOf(second)).toMatchObject({
        reservationStatus: notificationOf(first).reservationStatus,
        paymentStatus: notificationOf(first).paymentStatus,
        duplicate: true,
      });
      expect(await soldPerNight()).toEqual([1, 1]);
    });

    it('applies the change exactly once under concurrent delivery', async () => {
      const { booking, session } = await bookAndStartPayment();
      const body = fixture.notificationBody(
        booking.reservationNumber,
        session.paymentReference,
        session.amount,
      );

      const results = await Promise.all([
        fixture.postNotification(body),
        fixture.postNotification(body),
        fixture.postNotification(body),
      ]);

      // Exactly one delivery does the work. The others either replay its answer
      // (also a 200, but flagged duplicate) or report it still in flight with 409.
      const processed = results.filter(
        (res) => notificationOf(res).duplicate === false,
      );
      expect(processed).toHaveLength(1);
      expect(processed[0].status).toBe(200);
      expect(
        results.every((res) => res.status === 200 || res.status === 409),
      ).toBe(true);

      // The invariant that actually matters: the room is sold once, not three times.
      expect(await soldPerNight()).toEqual([1, 1]);
    });

    it('persists the terminal outcome on the event row for replay', async () => {
      const { booking, session } = await bookAndStartPayment();
      const body = fixture.notificationBody(
        booking.reservationNumber,
        session.paymentReference,
        session.amount,
      );

      await fixture.postNotification(body);

      const event = await fixture.webhookEvent(body.eventId);
      expect(event).toMatchObject({
        processingStatus: 'PROCESSED',
        responseStatus: 200,
        eventType: 'PAYMENT_SUCCEEDED',
      });
      expect(event?.processedAt).not.toBeNull();
      expect(event?.responsePayload).toMatchObject({
        reservationStatus: ReservationStatus.CONFIRMED,
      });
    });
  });

  describe('late success after the hold timestamp passed', () => {
    /**
     * The overbooking window: availability stops counting a hold the moment it
     * lapses, so another guest can take the room while the reservation is still
     * PAYMENT_PENDING. Confirming on status alone would sell the same room twice.
     */
    it('refuses to confirm when the room was reallocated, and flags a refund', async () => {
      const { booking, session } = await bookAndStartPayment(0);
      await fixture.forceHoldExpiry(booking.reservationNumber);

      const competitor = await fixture.postBooking(fixture.users[1]);
      expect(competitor.status).toBe(201);

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      expect(res.status).toBe(202);
      expect(notificationOf(res)).toMatchObject({
        refundRequired: true,
        paymentStatus: PaymentStatus.CAPTURED,
      });

      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).not.toBe(ReservationStatus.CONFIRMED);
      expect(await soldPerNight()).toEqual([0, 0]);

      const [payment] = await fixture.paymentsFor(booking.reservationNumber);
      expect(payment.refundRequired).toBe(true);
      expect(payment.refundReason).toBe('NO_INVENTORY_AT_CONFIRMATION');
    });

    it('recovers the booking when the room is still free', async () => {
      const { booking, session } = await bookAndStartPayment();
      await fixture.forceHoldExpiry(booking.reservationNumber);

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      expect(res.status).toBe(200);
      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).toBe(ReservationStatus.CONFIRMED);
      expect(await soldPerNight()).toEqual([1, 1]);
    });
  });

  describe('after the expiry job has run', () => {
    it('confirms an EXPIRED reservation when capacity is available', async () => {
      const { booking, session } = await bookAndStartPayment();
      await fixture.forceHoldExpiry(booking.reservationNumber);
      await fixture.maintenance.expireHolds();

      const before = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(before?.status).toBe(ReservationStatus.EXPIRED);
      expect(before?.inventoryHolds).toHaveLength(0);

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      expect(res.status).toBe(200);
      const after = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(after?.status).toBe(ReservationStatus.CONFIRMED);
      // Derived from reservation_items, since the hold rows are gone.
      expect(await soldPerNight()).toEqual([1, 1]);
    });

    it('flags a refund when the rooms were taken in the meantime', async () => {
      const { booking, session } = await bookAndStartPayment(0);
      await fixture.forceHoldExpiry(booking.reservationNumber);
      await fixture.maintenance.expireHolds();

      const competitor = await fixture.postBooking(fixture.users[1]);
      expect(competitor.status).toBe(201);

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      expect(res.status).toBe(202);
      expect(notificationOf(res).refundRequired).toBe(true);
      expect(await soldPerNight()).toEqual([0, 0]);
    });
  });

  describe('payment failure', () => {
    it('keeps the reservation pending with its hold intact so the guest can retry', async () => {
      const { booking, session } = await bookAndStartPayment();

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { eventType: 'PAYMENT_FAILED', failureReason: 'CARD_DECLINED' },
        ),
      );

      expect(res.status).toBe(200);
      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).toBe(ReservationStatus.PAYMENT_PENDING);
      expect(reservation?.inventoryHolds.length).toBeGreaterThan(0);
      expect(await soldPerNight()).toEqual([0, 0]);

      const [payment] = await fixture.paymentsFor(booking.reservationNumber);
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.failureReason).toBe('CARD_DECLINED');
    });

    it('treats a late success on a written-off attempt as a refund, not a booking', async () => {
      const { booking, session } = await bookAndStartPayment();

      await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { eventType: 'PAYMENT_FAILED', failureReason: 'CARD_DECLINED' },
        ),
      );

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      expect(res.status).toBe(202);
      const [payment] = await fixture.paymentsFor(booking.reservationNumber);
      expect(payment.refundReason).toBe('LATE_SUCCESS_ON_FAILED_ATTEMPT');
      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).toBe(ReservationStatus.PAYMENT_PENDING);
      expect(await soldPerNight()).toEqual([0, 0]);
    });
  });

  describe('permanent rejections', () => {
    it('rejects an amount that does not match the reservation total', async () => {
      const { booking, session } = await bookAndStartPayment();

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { amount: '1.00' },
        ),
      );

      expect(res.status).toBe(422);
      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation?.status).toBe(ReservationStatus.PAYMENT_PENDING);
    });

    it('rejects an unknown reservation reference and stores the outcome', async () => {
      const body = fixture.notificationBody(
        'ALTSTAY-20260101-ZZZZZZ',
        'PAY-does-not-exist',
        '1000.00',
      );

      const res = await fixture.postNotification(body);

      expect(res.status).toBe(422);
      const event = await fixture.webhookEvent(body.eventId);
      expect(event).toMatchObject({
        processingStatus: 'REJECTED',
        responseStatus: 422,
      });

      // A redelivery gets the same permanent answer.
      const again = await fixture.postNotification(body);
      expect(again.status).toBe(422);
      expect(notificationOf(again).duplicate).toBe(true);
    });

    it('accepts a decimal amount equal in value but written differently', async () => {
      const { booking, session } = await bookAndStartPayment();

      const res = await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { amount: Number(session.amount).toFixed(1) },
        ),
      );

      expect(res.status).toBe(200);
    });
  });

  describe('signature verification', () => {
    function validBody() {
      return fixture.notificationBody(
        'ALTSTAY-20260101-ZZZZZZ',
        'PAY-unused',
        '1000.00',
      );
    }

    it('rejects a wrong secret', async () => {
      const res = await fixture.postNotification(validBody(), {
        secret: 'not-the-secret',
      });
      expect(res.status).toBe(401);
    });

    it('rejects a body that changed after signing', async () => {
      const body = validBody();
      const signedFor = createHmac('sha256', fixture.signingSecret);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signedFor
        .update(`${timestamp}.${JSON.stringify(body)}`)
        .digest('hex');

      const res = await fixture.postNotification(
        { ...body, amount: '1.00' },
        { timestamp, signature },
      );

      expect(res.status).toBe(401);
    });

    it('rejects a stale timestamp', async () => {
      const stale = String(Math.floor(Date.now() / 1000) - 3600);
      const res = await fixture.postNotification(validBody(), {
        timestamp: stale,
      });
      expect(res.status).toBe(401);
    });

    it('rejects missing signature headers', async () => {
      const res = await fixture.http
        .post('/internal/payments/notifications')
        .send(validBody());
      expect(res.status).toBe(401);
    });
  });

  describe('customer-facing booking status', () => {
    it('shows PAYMENT_PENDING before the webhook lands, CONFIRMED after', async () => {
      const { booking, session } = await bookAndStartPayment();

      const before = bookingOf(
        await fixture.getBooking(fixture.users[0], booking.reservationNumber),
      );
      expect(before.status).toBe(ReservationStatus.PAYMENT_PENDING);
      expect(before.payment?.status).toBe(PaymentStatus.PENDING);

      await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
        ),
      );

      const after = bookingOf(
        await fixture.getBooking(fixture.users[0], booking.reservationNumber),
      );
      expect(after.status).toBe(ReservationStatus.CONFIRMED);
      expect(after.payment).toMatchObject({
        status: PaymentStatus.CAPTURED,
        refundRequired: false,
      });
      // Provider identifiers are internal and must not reach the browser.
      expect(after.payment).not.toHaveProperty('providerPaymentId');
      expect(after.payment).not.toHaveProperty('providerOrderId');
    });

    it('exposes the retryable failed attempt while still pending', async () => {
      const { booking, session } = await bookAndStartPayment();

      await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { eventType: 'PAYMENT_FAILED', failureReason: 'CARD_DECLINED' },
        ),
      );

      const res = bookingOf(
        await fixture.getBooking(fixture.users[0], booking.reservationNumber),
      );

      expect(res.payment?.status).toBe(PaymentStatus.FAILED);
      expect(res.payment?.failureReason).toBe('CARD_DECLINED');
    });

    it('after a retry, GET shows the live attempt instead of the earlier failure', async () => {
      const { booking, session } = await bookAndStartPayment();

      await fixture.postNotification(
        fixture.notificationBody(
          booking.reservationNumber,
          session.paymentReference,
          session.amount,
          { eventType: 'PAYMENT_FAILED', failureReason: 'CARD_DECLINED' },
        ),
      );

      const retry = sessionOf(
        await fixture.postSession(fixture.users[0], booking.reservationNumber),
      );
      expect(retry.paymentReference).not.toBe(session.paymentReference);

      const res = bookingOf(
        await fixture.getBooking(fixture.users[0], booking.reservationNumber),
      );

      expect(res.payment?.paymentReference).toBe(retry.paymentReference);
      expect(res.payment?.status).toBe(PaymentStatus.PENDING);
      expect(res.payment).not.toHaveProperty('providerPaymentId');
    });
  });

  describe('concurrent expiry and confirmation', () => {
    it('never both confirms and leaves the reservation expired', async () => {
      const { booking, session } = await bookAndStartPayment();
      const reservation = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      expect(reservation).toBeTruthy();

      // Put the hold on the boundary so both paths are eligible for the lock.
      await fixture.forceHoldExpiry(booking.reservationNumber);

      const body = fixture.notificationBody(
        booking.reservationNumber,
        session.paymentReference,
        session.amount,
      );

      await Promise.all([
        fixture.bookings.expireReservation(reservation!.id),
        fixture.postNotification(body),
      ]);

      const after = await fixture.reservationByNumber(
        booking.reservationNumber,
      );
      const sold = await soldPerNight();

      if (after?.status === ReservationStatus.CONFIRMED) {
        expect(sold).toEqual([1, 1]);
        expect(after.holdExpiresAt).toBeNull();
      } else {
        expect(after?.status).toBe(ReservationStatus.EXPIRED);
        expect(sold).toEqual([0, 0]);
      }

      // The room is never sold twice, and never sold while still marked expired.
      const soldTotal = sold.reduce((sum, n) => sum + n, 0);
      expect(soldTotal === 0 || soldTotal === 2).toBe(true);
      if (soldTotal === 2) {
        expect(after?.status).toBe(ReservationStatus.CONFIRMED);
      }
    });
  });
});
