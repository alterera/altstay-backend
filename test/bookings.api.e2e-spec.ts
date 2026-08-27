import { randomUUID } from 'node:crypto';
import { ReservationStatus } from '../src/prisma/client';
import {
  BookingFixture,
  bookingOf,
  errorOf,
  listOf,
} from './helpers/booking-test-fixture';

describe('Bookings API (e2e)', () => {
  describe('creating a booking', () => {
    const fixture = new BookingFixture();
    const NIGHTLY = 2500;

    beforeAll(async () => {
      // Generous inventory: this block books repeatedly and every booking holds a
      // room, so a thin fixture would fail on sold-out rather than on the
      // behaviour under test.
      await fixture.setup({
        totalRooms: 15,
        users: 2,
        nights: 2,
        nightlyRate: NIGHTLY,
      });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('prices the stay on the server and ignores any client-supplied amount', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        // `totalAmount` is not part of the DTO; the strict validation pipe must
        // reject it rather than let a client propose its own price.
        fixture.bookingBody({ totalAmount: 1 }),
        randomUUID(),
      );

      expect(response.status).toBe(400);
    });

    it('returns an authoritative quote', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({ rooms: 2, adults: 4 }),
        randomUUID(),
      );

      expect(response.status).toBe(201);

      const expectedSubtotal = NIGHTLY * 2 * 2; // 2 nights x 2 rooms
      const expectedTax = Math.round(expectedSubtotal * 0.18);

      expect(response.body).toMatchObject({
        status: ReservationStatus.PAYMENT_PENDING,
        currency: 'INR',
        nights: 2,
        subtotal: expectedSubtotal,
        taxAmount: expectedTax,
        discountAmount: 0,
        totalAmount: expectedSubtotal + expectedTax,
      });
      expect(bookingOf(response).reservationNumber).toMatch(
        /^ALTSTAY-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/,
      );
      expect(bookingOf(response).holdExpiresAt).not.toBeNull();
    });

    it('emits calendar dates rather than timestamps', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );

      expect(bookingOf(response).checkIn).toBe(fixture.checkIn);
      expect(bookingOf(response).checkOut).toBe(fixture.checkOut);
    });

    it('snapshots the rate so later price changes cannot rewrite it', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );
      const reservation = await fixture.reservationByNumber(
        bookingOf(response).reservationNumber,
      );

      const item = reservation!.items[0];
      expect(item.roomTypeName).toBe('E2E Deluxe King');
      expect(item.ratePlanName).toBe('E2E Room Only');
      expect(item.quantity).toBe(1);

      const snapshot = item.snapshotJson as Record<string, unknown>;
      expect(snapshot.propertySlug).toBe(fixture.propertySlug);
      expect(snapshot.taxRate).toBe(0.18);
      expect(snapshot.nights).toEqual([
        { date: fixture.checkIn, basePrice: NIGHTLY },
        expect.objectContaining({ basePrice: NIGHTLY }),
      ]);
      expect(snapshot.quotedAt).toBeDefined();

      // Raise the published rate; the stored snapshot must not move.
      await fixture.prisma.ratePrice.updateMany({
        where: { ratePlanId: fixture.ratePlanId },
        data: { basePrice: 9999 },
      });
      const reread = await fixture.reservationByNumber(
        bookingOf(response).reservationNumber,
      );
      expect(Number(reread!.items[0].subtotal)).toBe(NIGHTLY * 2);

      await fixture.prisma.ratePrice.updateMany({
        where: { ratePlanId: fixture.ratePlanId },
        data: { basePrice: NIGHTLY },
      });
    });

    it('stores the guest supplied with the request', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );
      const reservation = await fixture.reservationByNumber(
        bookingOf(response).reservationNumber,
      );

      expect(reservation!.guests).toHaveLength(1);
      expect(reservation!.guests[0]).toMatchObject({
        firstName: 'Asha',
        lastName: 'Rao',
        email: 'asha@example.com',
      });
    });

    it('records business booking details when supplied', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({
          businessBooking: {
            companyName: 'Alterera Technologies',
            gstin: '29ABCDE1234F1Z5',
            billingAddress: '12 MG Road, Bengaluru 560001',
          },
        }),
        randomUUID(),
      );

      expect(response.status).toBe(201);
      expect(bookingOf(response).businessBooking).toEqual({
        companyName: 'Alterera Technologies',
        gstin: '29ABCDE1234F1Z5',
        billingAddress: '12 MG Road, Bengaluru 560001',
      });
    });

    it('leaves business details null for a personal booking', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );

      expect(bookingOf(response).businessBooking).toBeNull();
    });

    it('requires the whole business block once any of it is present', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({
          businessBooking: { companyName: 'Alterera Technologies' },
        }),
        randomUUID(),
      );

      expect(response.status).toBe(400);
    });

    it('creates one hold per night', async () => {
      const before = await fixture.holdsForFixture();
      await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );
      const after = await fixture.holdsForFixture();

      expect(after.length - before.length).toBe(2);
    });

    it('does not consume soldRooms before payment exists', async () => {
      const inventory = await fixture.prisma.roomInventory.findMany({
        where: { roomTypeId: fixture.roomTypeId },
      });

      expect(inventory.every((row) => row.soldRooms === 0)).toBe(true);
    });
  });

  describe('request validation', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 3, users: 1, nights: 2 });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('rejects an unknown property slug', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({ propertySlug: 'no-such-hotel-anywhere' }),
        randomUUID(),
      );

      expect(response.status).toBe(404);
    });

    it('rejects a rate plan from another property', async () => {
      const other = new BookingFixture();
      await other.setup({ totalRooms: 1, users: 1, nights: 1 });

      try {
        const response = await fixture.postBooking(
          fixture.users[0],
          fixture.bookingBody({ ratePlanId: other.ratePlanId }),
          randomUUID(),
        );

        expect(response.status).toBe(404);
      } finally {
        await other.teardown();
      }
    });

    it('rejects a checkout that is not after check-in', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({ checkOut: fixture.checkIn }),
        randomUUID(),
      );

      expect(response.status).toBe(400);
    });

    it('rejects a stay in the past', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({
          checkIn: '2020-01-01',
          checkOut: '2020-01-03',
        }),
        randomUUID(),
      );

      expect(response.status).toBe(400);
    });

    it('rejects more guests than the room type sleeps', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({ adults: 9, rooms: 1 }),
        randomUUID(),
      );

      expect(response.status).toBe(400);
    });

    it('rejects dates with no loaded inventory', async () => {
      const far = new Date();
      far.setUTCDate(far.getUTCDate() + 400);
      const farEnd = new Date(far);
      farEnd.setUTCDate(farEnd.getUTCDate() + 1);

      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody({
          checkIn: far.toISOString().slice(0, 10),
          checkOut: farEnd.toISOString().slice(0, 10),
        }),
        randomUUID(),
      );

      expect(response.status).toBe(409);
    });

    it('creates nothing for any rejected request', async () => {
      const reservations = await fixture.prisma.reservation.findMany({
        where: { propertyId: fixture.propertyId },
      });

      expect(reservations).toHaveLength(0);
    });
  });

  describe('reading bookings', () => {
    const fixture = new BookingFixture();
    let reference: string;

    beforeAll(async () => {
      await fixture.setup({ totalRooms: 5, users: 2, nights: 2 });
      const created = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );
      reference = bookingOf(created).reservationNumber;
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('requires authentication', async () => {
      await fixture.http.get(`/bookings/${reference}`).expect(401);
      await fixture.http.get('/bookings/me').expect(401);
      await fixture.http
        .post('/bookings')
        .send(fixture.bookingBody())
        .expect(401);
    });

    it('returns the booking to its owner', async () => {
      const response = await fixture.http
        .get(`/bookings/${reference}`)
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(response.status).toBe(200);
      expect(bookingOf(response).reservationNumber).toBe(reference);
      expect(bookingOf(response).property.slug).toBe(fixture.propertySlug);
    });

    // The reference is a reference, not a credential. Answering 403 would confirm
    // it exists and make this endpoint an enumeration oracle.
    it("answers 404, not 403, for someone else's booking", async () => {
      const response = await fixture.http
        .get(`/bookings/${reference}`)
        .set('Authorization', `Bearer ${fixture.users[1].token}`);

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(reference);
    });

    it('answers 404 for a reference that does not exist', async () => {
      const response = await fixture.http
        .get('/bookings/ALTSTAY-20260819-ZZZZZZ')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(response.status).toBe(404);
    });

    it("lists only the caller's own bookings", async () => {
      const mine = await fixture.http
        .get('/bookings/me')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(mine.status).toBe(200);
      expect(listOf(mine).total).toBe(1);
      expect(listOf(mine).results[0].reservationNumber).toBe(reference);

      const theirs = await fixture.http
        .get('/bookings/me')
        .set('Authorization', `Bearer ${fixture.users[1].token}`);

      expect(listOf(theirs).total).toBe(0);
      expect(listOf(theirs).results).toEqual([]);
    });

    it('paginates', async () => {
      await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );

      const firstPage = await fixture.http
        .get('/bookings/me?page=1&limit=1')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(listOf(firstPage).results).toHaveLength(1);
      expect(listOf(firstPage).total).toBe(2);
      expect(listOf(firstPage).hasMore).toBe(true);

      const secondPage = await fixture.http
        .get('/bookings/me?page=2&limit=1')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(listOf(secondPage).results).toHaveLength(1);
      expect(listOf(secondPage).hasMore).toBe(false);
      expect(listOf(secondPage).results[0].reservationNumber).not.toBe(
        listOf(firstPage).results[0].reservationNumber,
      );
    });

    it('filters by status', async () => {
      const response = await fixture.http
        .get('/bookings/me?status=CONFIRMED')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(listOf(response).total).toBe(0);
    });

    it('puts unpaid bookings in pending, not upcoming', async () => {
      const pending = await fixture.http
        .get('/bookings/me?tab=pending')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(pending.status).toBe(200);
      expect(listOf(pending).total).toBeGreaterThan(0);
      expect(
        listOf(pending).results.every(
          (booking) => booking.status === 'PAYMENT_PENDING',
        ),
      ).toBe(true);

      const upcoming = await fixture.http
        .get('/bookings/me?tab=upcoming')
        .set('Authorization', `Bearer ${fixture.users[0].token}`);

      expect(listOf(upcoming).total).toBe(0);
    });
  });

  describe('rate limiting', () => {
    const fixture = new BookingFixture();

    beforeAll(async () => {
      // Real limiter this time; 12 rooms so inventory never becomes the reason a
      // request is refused.
      await fixture.setup({
        totalRooms: 12,
        users: 1,
        nights: 1,
        enableRateLimit: true,
      });
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it('throttles a user hammering the endpoint', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const response = await fixture.postBooking(
          fixture.users[0],
          fixture.bookingBody(),
          randomUUID(),
        );
        statuses.push(response.status);
      }

      expect(statuses.filter((status) => status === 201)).toHaveLength(10);
      expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    });

    it('tells the caller when to retry', async () => {
      const response = await fixture.postBooking(
        fixture.users[0],
        fixture.bookingBody(),
        randomUUID(),
      );

      expect(response.status).toBe(429);
      expect(errorOf(response).retryAfterSec).toBeGreaterThan(0);
    });
  });
});
