import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '../src/prisma/client';
import { BookingFixture, bookingOf } from './helpers/booking-test-fixture';

/**
 * Overselling is the failure this whole design exists to prevent, so these tests
 * run against real PostgreSQL. `SELECT ... FOR UPDATE` is what serializes
 * competing bookings; nothing that fakes the database can demonstrate it works.
 */
describe('Bookings concurrency (e2e)', () => {
  describe('10 users racing for 2 rooms', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 2, users: 10, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('sells exactly the 2 rooms that exist', async () => {
      const responses = await Promise.all(
        fixture.users.map((user) =>
          fixture.postBooking(user, fixture.bookingBody(), randomUUID()),
        ),
      );

      const created = responses.filter((res) => res.status === 201);
      const rejected = responses.filter((res) => res.status === 409);

      expect(created).toHaveLength(2);
      expect(rejected).toHaveLength(8);
      // Nothing may fail for an unexpected reason: a 500 here would mean a
      // deadlock or a lock timeout rather than a clean sold-out answer.
      expect(responses.filter((res) => res.status >= 500)).toHaveLength(0);
    });

    it('records both winners as PAYMENT_PENDING with a hold deadline', async () => {
      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });

      expect(reservations).toHaveLength(2);
      for (const reservation of reservations) {
        expect(reservation.status).toBe(ReservationStatus.PAYMENT_PENDING);
        expect(reservation.holdExpiresAt).not.toBeNull();
        expect(reservation.holdExpiresAt!.getTime()).toBeGreaterThan(
          Date.now(),
        );
      }
    });

    it('holds exactly the sold quantity on every night', async () => {
      const holds = await fixture.holdsForFixture();

      // 2 winners x 2 nights.
      expect(holds).toHaveLength(4);

      const perNight = new Map<string, number>();
      for (const hold of holds) {
        const key = hold.date.toISOString().slice(0, 10);
        perNight.set(key, (perNight.get(key) ?? 0) + hold.quantity);
      }

      expect([...perNight.values()]).toEqual([2, 2]);
    });

    it('leaves no rooms for an eleventh attempt', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );

      expect(response.status).toBe(409);
    });
  });

  describe('two users, one room', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 1, users: 2, nights: 1 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    // The invariant in its simplest form.
    it('gives the room to exactly one of them', async () => {
      const [first, second] = await Promise.all([
        fixture.postBooking(
          fixture.users[0],
          fixture.bookingBody(),
          randomUUID(),
        ),
        fixture.postBooking(
          fixture.users[1],
          fixture.bookingBody(),
          randomUUID(),
        ),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });
      expect(reservations).toHaveLength(1);
    });
  });

  describe('inventory released by hold expiry', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 1, users: 2, nights: 1 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    // Proves an expired hold genuinely returns the room, rather than the row
    // merely being marked stale.
    it('lets a second user book the room the first one let lapse', async () => {
      const userA = fixture.users[0];
      const userB = fixture.users[1];

      const firstBooking = await fixture.postBooking(
        userA,
        fixture.bookingBody(),
        randomUUID(),
      );
      expect(firstBooking.status).toBe(201);
      const referenceA = bookingOf(firstBooking).reservationNumber;

      // While A still holds it, B cannot have it.
      const blocked = await fixture.postBooking(
        userB,
        fixture.bookingBody(),
        randomUUID(),
      );
      expect(blocked.status).toBe(409);

      await fixture.forceHoldExpiry(referenceA);
      const expired = await fixture.maintenance.expireHolds();
      expect(expired).toBe(1);

      const reservationA = await fixture.reservationByNumber(referenceA);
      expect(reservationA?.status).toBe(ReservationStatus.EXPIRED);
      expect(reservationA?.inventoryHolds).toHaveLength(0);

      const secondBooking = await fixture.postBooking(
        userB,
        fixture.bookingBody(),
        randomUUID(),
      );
      expect(secondBooking.status).toBe(201);

      const reservationB = await fixture.reservationByNumber(
        bookingOf(secondBooking).reservationNumber,
      );
      expect(reservationB?.status).toBe(ReservationStatus.PAYMENT_PENDING);
      expect(reservationB?.inventoryHolds).toHaveLength(1);
    });

    it('is a no-op when run again with nothing left to expire', async () => {
      await expect(fixture.maintenance.expireHolds()).resolves.toBe(0);
    });

    it('never expires a reservation whose hold is still current', async () => {
      const reservations = await fixture.prisma.reservation.findMany({
        where: {
          propertyId: fixture.propertyId,
          status: ReservationStatus.PAYMENT_PENDING,
        },
        select: { id: true },
      });
      expect(reservations).toHaveLength(1);

      // Re-checked under the row lock: the hold has not lapsed, so it is skipped.
      await expect(
        fixture.bookings.expireReservation(reservations[0].id),
      ).resolves.toBe(false);
    });
  });
});
