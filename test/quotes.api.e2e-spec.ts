import {
  BookingFixture,
} from './helpers/booking-test-fixture';

describe('Quotes API (e2e)', () => {
  const fixture = new BookingFixture();
  const NIGHTLY = 2500;

  beforeAll(async () => {
    await fixture.setup({
      totalRooms: 5,
      users: 1,
      nights: 2,
      nightlyRate: NIGHTLY,
    });
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  it('returns a browse-only quote without creating a hold', async () => {
    const response = await fixture.http.get('/quotes').query({
      propertySlug: fixture.propertySlug,
      roomTypeId: fixture.roomTypeId,
      ratePlanId: fixture.ratePlanId,
      checkIn: fixture.checkIn,
      checkOut: fixture.checkOut,
      rooms: 1,
      adults: 2,
    });

    expect(response.status).toBe(200);
    const expectedSubtotal = NIGHTLY * 2;
    const expectedTax = Math.round(expectedSubtotal * 0.18);
    expect(response.body).toMatchObject({
      subtotal: expectedSubtotal,
      taxAmount: expectedTax,
      totalAmount: expectedSubtotal + expectedTax,
      currency: 'INR',
      nights: 2,
      available: true,
    });

    const holds = await fixture.holdsForFixture();
    expect(holds).toHaveLength(0);
  });

  it('creates an intent snapshot without inventory holds', async () => {
    const response = await fixture.createIntent(fixture.users[0]);

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.body).toMatchObject({
      quoteToken: expect.any(String),
      expiresAt: expect.any(String),
      quote: {
        subtotal: NIGHTLY * 2,
        currency: 'INR',
      },
      property: { slug: fixture.propertySlug },
    });

    const holds = await fixture.holdsForFixture();
    expect(holds).toHaveLength(0);
  });

  it('commits a booking from a quote token and starts a hold', async () => {
    const intent = await fixture.createIntent(fixture.users[0]);
    const quoteToken = (intent.body as { quoteToken: string }).quoteToken;

    const response = await fixture.postBooking(
      fixture.users[0],
      fixture.bookingBody({ quoteToken }),
    );

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.body).toMatchObject({
      status: 'PAYMENT_PENDING',
      holdExpiresAt: expect.any(String),
    });

    const holds = await fixture.holdsForFixture();
    expect(holds.length).toBeGreaterThan(0);
  });
});
