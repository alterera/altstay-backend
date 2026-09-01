import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricingService, TAX_RATE } from './pricing.service';
import { RatePriceLike } from './pricing.types';

const utc = (day: string) => new Date(`2026-09-${day}T00:00:00.000Z`);

function price(
  day: string,
  basePrice: number,
  overrides: Partial<RatePriceLike> = {},
): RatePriceLike {
  return {
    date: utc(day),
    basePrice,
    currency: 'INR',
    minStay: null,
    maxStay: null,
    closedToArrival: false,
    closedToDeparture: false,
    ...overrides,
  };
}

describe('PricingService', () => {
  let pricing: PricingService;

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    pricing = new PricingService(config);
  });

  describe('estimateTaxes', () => {
    it('applies the flat Phase A tax rate', () => {
      expect(pricing.estimateTaxes(2200)).toBe(Math.round(2200 * TAX_RATE));
      expect(pricing.estimateTaxes(2200)).toBe(396);
    });

    it('rounds to whole currency units', () => {
      expect(pricing.estimateTaxes(1001)).toBe(180);
    });
  });

  describe('matchNights', () => {
    it('orders prices to match the requested nights', () => {
      const nights = [utc('12'), utc('10'), utc('11')];
      const prices = [price('10', 100), price('11', 200), price('12', 300)];

      const ordered = pricing.matchNights(prices, nights);

      expect(ordered?.map((p) => p.basePrice)).toEqual([300, 100, 200]);
    });

    it('returns null when any night has no price', () => {
      const nights = [utc('10'), utc('11'), utc('12')];
      const prices = [price('10', 100), price('12', 300)];

      expect(pricing.matchNights(prices, nights)).toBeNull();
    });

    it('returns null for an empty stay', () => {
      expect(pricing.matchNights([price('10', 100)], [])).toBeNull();
    });
  });

  describe('computeQuote', () => {
    it('multiplies the nightly total by the room count', () => {
      const quote = pricing.computeQuote(
        [price('10', 1000), price('11', 1200)],
        2,
      );

      expect(quote.nights).toBe(2);
      expect(quote.rooms).toBe(2);
      expect(quote.subtotal).toBe(4400);
      expect(quote.taxAmount).toBe(792);
      expect(quote.discountAmount).toBe(0);
      expect(quote.totalAmount).toBe(5192);
      expect(quote.currency).toBe('INR');
      expect(quote.taxRate).toBe(TAX_RATE);
    });

    it('prices a single night for a single room', () => {
      const quote = pricing.computeQuote([price('10', 3500)], 1);

      expect(quote.subtotal).toBe(3500);
      expect(quote.taxAmount).toBe(630);
      expect(quote.totalAmount).toBe(4130);
    });

    it('handles Decimal-like string prices from the database', () => {
      const quote = pricing.computeQuote(
        [{ date: utc('10'), basePrice: '1500.00' }],
        1,
      );

      expect(quote.subtotal).toBe(1500);
    });

    it('exposes the nightly breakdown for snapshots', () => {
      const quote = pricing.computeQuote(
        [price('10', 1000), price('11', 1200)],
        1,
      );

      expect(quote.nightly).toEqual([
        { date: utc('10'), basePrice: 1000 },
        { date: utc('11'), basePrice: 1200 },
      ]);
    });

    it('rejects a stay with no nights', () => {
      expect(() => pricing.computeQuote([], 1)).toThrow(BadRequestException);
    });

    it.each([0, -1, 1.5])('rejects a room count of %p', (rooms) => {
      expect(() => pricing.computeQuote([price('10', 100)], rooms)).toThrow(
        BadRequestException,
      );
    });

    it('exposes coin earn preview for members without checkout discount', () => {
      const quote = pricing.computeQuote([price('10', 3000)], 1, {
        planCode: 'INDIVIDUAL',
        discountPercent: 5,
      });

      expect(quote.subtotal).toBe(3000);
      expect(quote.discountAmount).toBe(0);
      expect(quote.taxAmount).toBe(Math.round(3000 * TAX_RATE));
      expect(quote.totalAmount).toBe(3000 + quote.taxAmount);
      expect(quote.coinEarnPreview).toEqual({
        planCode: 'INDIVIDUAL',
        earnPercent: 5,
        earnableAmount: 150,
      });
    });

    it('exposes 10% coin earn preview for corporate members', () => {
      const quote = pricing.computeQuote([price('10', 3000)], 1, {
        planCode: 'CORPORATE',
        discountPercent: 10,
      });

      expect(quote.discountAmount).toBe(0);
      expect(quote.coinEarnPreview?.earnableAmount).toBe(300);
      expect(quote.totalAmount).toBe(3000 + Math.round(3000 * TAX_RATE));
    });
  });

  describe('applyCoinRedemption', () => {
    it('reduces subtotal and recalculates tax', () => {
      const base = pricing.computeQuote([price('10', 3000)], 1);
      const quote = pricing.applyCoinRedemption(base, 500);

      expect(quote.coinsRedeemed).toBe(500);
      expect(quote.subtotal).toBe(3000);
      expect(quote.taxAmount).toBe(Math.round(2500 * TAX_RATE));
      expect(quote.totalAmount).toBe(2500 + quote.taxAmount);
    });

    it('rejects redemption above room subtotal', () => {
      const base = pricing.computeQuote([price('10', 1000)], 1);
      expect(() => pricing.applyCoinRedemption(base, 1001)).toThrow(
        BadRequestException,
      );
    });
  });

  // These columns are not written by the admin panel today, so every assertion
  // here guards a rule that only becomes reachable once they are.
  describe('assertStayAllowed', () => {
    it('passes when no restrictions are set', () => {
      expect(() =>
        pricing.assertStayAllowed([price('10', 100), price('11', 100)]),
      ).not.toThrow();
    });

    it('rejects a stay shorter than minStay on the arrival night', () => {
      expect(() =>
        pricing.assertStayAllowed([price('10', 100, { minStay: 3 })]),
      ).toThrow(/minimum stay of 3/);
    });

    it('accepts a stay that exactly meets minStay', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100, { minStay: 2 }),
          price('11', 100),
        ]),
      ).not.toThrow();
    });

    it('rejects a stay longer than maxStay', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100, { maxStay: 1 }),
          price('11', 100),
        ]),
      ).toThrow(/maximum stay of 1/);
    });

    it('rejects arrival on a closed-to-arrival night', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100, { closedToArrival: true }),
          price('11', 100),
        ]),
      ).toThrow(/closed to arrival/);
    });

    it('ignores closedToArrival on a night that is not the arrival', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100),
          price('11', 100, { closedToArrival: true }),
        ]),
      ).not.toThrow();
    });

    it('rejects departure after a closed-to-departure final night', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100),
          price('11', 100, { closedToDeparture: true }),
        ]),
      ).toThrow(/closed to departure/);
    });

    it('ignores closedToDeparture on a night that is not the last', () => {
      expect(() =>
        pricing.assertStayAllowed([
          price('10', 100, { closedToDeparture: true }),
          price('11', 100),
        ]),
      ).not.toThrow();
    });
  });

  describe('loadAndQuote', () => {
    const nights = [utc('10'), utc('11')];

    function clientReturning(rows: RatePriceLike[]) {
      return {
        ratePrice: { findMany: jest.fn().mockResolvedValue(rows) },
      } as unknown as Parameters<PricingService['loadAndQuote']>[0];
    }

    it('prices from the rows read through the given client', async () => {
      const client = clientReturning([price('10', 1000), price('11', 1200)]);

      const quote = await pricing.loadAndQuote(client, 'rate-1', nights, 2);

      expect(quote.subtotal).toBe(4400);
      expect(quote.totalAmount).toBe(5192);
    });

    it('refuses to price a stay with an unpriced night', async () => {
      const client = clientReturning([price('10', 1000)]);

      await expect(
        pricing.loadAndQuote(client, 'rate-1', nights, 1),
      ).rejects.toThrow(/not priced for every night/);
    });

    it('enforces rate restrictions before quoting', async () => {
      const client = clientReturning([
        price('10', 1000, { minStay: 5 }),
        price('11', 1200),
      ]);

      await expect(
        pricing.loadAndQuote(client, 'rate-1', nights, 1),
      ).rejects.toThrow(/minimum stay of 5/);
    });
  });
});
