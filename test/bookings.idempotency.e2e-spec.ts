import { randomUUID } from 'node:crypto';
import { IdempotencyStatus } from '../src/prisma/client';
import {
  BookingFixture,
  bookingOf,
  errorOf,
} from './helpers/booking-test-fixture';

/**
 * The suites below deliberately over-provision inventory. If idempotency were
 * broken, the extra rooms let the duplicate bookings actually succeed, so the
 * assertions fail loudly instead of being masked by a sold-out 409.
 */
describe('Bookings idempotency (e2e)', () => {
  describe('concurrent requests with the same key', () => {
    const fixture = new BookingFixture();
    const PARALLEL = 5;

    beforeAll(async () => {
      await fixture.setup({ totalRooms: PARALLEL, users: 1, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    // A read-then-write check would let several of these through.
    it('creates exactly one reservation', async () => {
      const key = randomUUID();
      const body = fixture.bookingBody();

      const responses = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          fixture.postBooking(fixture.users[0], body, key),
        ),
      );

      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });
      expect(reservations).toHaveLength(1);

      // The winner returns the booking; the rest are told a sibling owns the key
      // or are handed the same booking back.
      const created = responses.filter((res) => res.status === 201);
      const conflicted = responses.filter((res) => res.status === 409);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(created.length + conflicted.length).toBe(PARALLEL);
      expect(responses.filter((res) => res.status >= 500)).toHaveLength(0);

      const references = new Set(
        responses
          .filter((res) => res.status < 400)
          .map((res) => bookingOf(res).reservationNumber),
      );
      expect(references.size).toBe(1);
      expect([...references][0]).toBe(reservations[0].reservationNumber);
    });

    it('holds inventory only once', async () => {
      const holds = await fixture.holdsForFixture();

      // One reservation x 2 nights.
      expect(holds).toHaveLength(2);
      expect(holds.every((hold) => hold.quantity === 1)).toBe(true);
    });

    it('leaves a single completed claim pointing at that reservation', async () => {
      const claims = await fixture.prisma.bookingIdempotency.findMany({
        where: { userId: fixture.users[0].id },
      });

      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe(IdempotencyStatus.COMPLETED);

      const reservation = await fixture.prisma.reservation.findFirst({
        where: { propertyId: fixture.propertyId },
      });
      expect(claims[0].reservationId).toBe(reservation!.id);
    });
  });

  describe('retry after a lost response', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 3, users: 1, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    // The booking committed but the client never saw the reply, so it retries.
    it('returns the original booking instead of making a second one', async () => {
      const key = randomUUID();
      const body = fixture.bookingBody();
      const user = fixture.users[0];

      const first = await fixture.postBooking(user, body, key);
      expect(first.status).toBe(201);

      const retry = await fixture.postBooking(user, body, key);

      expect(retry.status).toBeLessThan(400);
      expect(bookingOf(retry).reservationNumber).toBe(
        bookingOf(first).reservationNumber,
      );
      expect(bookingOf(retry).totalAmount).toBe(bookingOf(first).totalAmount);
      expect(bookingOf(retry).holdExpiresAt).toBe(
        bookingOf(first).holdExpiresAt,
      );

      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });
      expect(reservations).toHaveLength(1);
    });

    it('does not duplicate the inventory hold', async () => {
      const holds = await fixture.holdsForFixture();

      expect(holds).toHaveLength(2);
    });

    it('keeps replaying for repeated retries', async () => {
      const key = randomUUID();
      const body = fixture.bookingBody();
      const user = fixture.users[0];

      const first = await fixture.postBooking(user, body, key);
      const second = await fixture.postBooking(user, body, key);
      const third = await fixture.postBooking(user, body, key);

      expect(bookingOf(second).reservationNumber).toBe(
        bookingOf(first).reservationNumber,
      );
      expect(bookingOf(third).reservationNumber).toBe(
        bookingOf(first).reservationNumber,
      );
    });
  });

  describe('key reuse with a different body', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 4, users: 1, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('is rejected as a conflict', async () => {
      const key = randomUUID();
      const user = fixture.users[0];

      const first = await fixture.postBooking(user, fixture.bookingBody(), key);
      expect(first.status).toBe(201);

      const changed = await fixture.postBooking(
        user,
        fixture.bookingBody({ rooms: 2 }),
        key,
      );

      expect(changed.status).toBe(409);
      expect(errorOf(changed).message).toMatch(/different booking request/);

      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });
      expect(reservations).toHaveLength(1);
    });

    it('ignores field ordering when comparing bodies', async () => {
      const key = randomUUID();
      const user = fixture.users[0];

      const first = await fixture.postBooking(user, fixture.bookingBody(), key);
      expect(first.status).toBe(201);

      const reordered = {
        adults: 2,
        rooms: 1,
        guest: {
          phone: '+919812345678',
          email: 'asha@example.com',
          lastName: 'Rao',
          firstName: 'Asha',
        },
        checkOut: fixture.checkOut,
        checkIn: fixture.checkIn,
        ratePlanId: fixture.ratePlanId,
        roomTypeId: fixture.roomTypeId,
        propertySlug: fixture.propertySlug,
      };

      const retry = await fixture.postBooking(user, reordered, key);

      expect(retry.status).toBeLessThan(400);
      expect(bookingOf(retry).reservationNumber).toBe(
        bookingOf(first).reservationNumber,
      );
    });
  });

  describe('key reuse after the cleanup sweep', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 3, users: 1, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    // Expiry alone frees nothing: the unique index still matches until the row is
    // actually deleted.
    it('only frees the key once the row is deleted', async () => {
      const key = randomUUID();
      const body = fixture.bookingBody();
      const user = fixture.users[0];

      const first = await fixture.postBooking(user, body, key);
      expect(first.status).toBe(201);

      // Age the claim past its TTL. It is still present, so the key still maps to
      // the original booking.
      await fixture.prisma.bookingIdempotency.updateMany({
        where: { userId: user.id, idempotencyKey: key },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const beforeSweep = await fixture.postBooking(user, body, key);
      expect(bookingOf(beforeSweep).reservationNumber).toBe(
        bookingOf(first).reservationNumber,
      );

      const { expired } = await fixture.idempotency.cleanup();
      expect(expired).toBeGreaterThanOrEqual(1);

      const afterSweep = await fixture.postBooking(user, body, key);
      expect(afterSweep.status).toBe(201);
      expect(bookingOf(afterSweep).reservationNumber).not.toBe(
        bookingOf(first).reservationNumber,
      );

      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });
      expect(reservations).toHaveLength(2);
    });
  });

  describe('Idempotency-Key header requirements', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 2, users: 1, nights: 1 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('rejects a booking with no key', async () => {
      const response = await fixture.http
        .post('/bookings')
        .set('Authorization', `Bearer ${fixture.users[0].token}`)
        .send(fixture.bookingBody());

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(
        /Idempotency-Key header is required/,
      );
    });

    it('rejects a key that is too short to be unique', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        'abc',
      );

      expect(response.status).toBe(400);
    });

    it('rejects a key containing unsupported characters', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        'has spaces and #hash',
      );

      expect(response.status).toBe(400);
    });

    it('creates nothing for any of the rejected requests', async () => {
      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });

      expect(reservations).toHaveLength(0);
    });
  });
});
