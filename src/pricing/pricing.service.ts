import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MembershipPricingContext,
  NightlyRate,
  PricingClient,
  Quote,
  RatePriceLike,
} from './pricing.types';

/**
 * Single source of truth for money. Both the browse path (SearchService) and the
 * booking path (BookingsService) must price through this service so the number a
 * guest sees while browsing and the number they are charged cannot drift.
 *
 * Phase A rules: flat tax rate, no promotions, no convenience fee.
 */
export const TAX_RATE = 0.18;
export const DEFAULT_CURRENCY = 'INR';

@Injectable()
export class PricingService {
  readonly taxRate = TAX_RATE;

  constructor(private readonly config: ConfigService) {}

  estimateTaxes(amount: number): number {
    return Math.round(amount * TAX_RATE);
  }

  /**
   * Orders `prices` to match `nights` exactly.
   *
   * @returns the ordered rows, or `null` when any night has no price. Search
   * relies on the `null` branch to silently skip unbookable rate plans.
   */
  matchNights<T extends RatePriceLike>(
    prices: T[],
    nights: Date[],
  ): T[] | null {
    if (!nights.length) return null;

    const byTime = new Map(prices.map((p) => [p.date.getTime(), p]));
    const ordered: T[] = [];
    for (const night of nights) {
      const price = byTime.get(night.getTime());
      if (!price) return null;
      ordered.push(price);
    }
    return ordered;
  }

  /**
   * Pure quote math over already-loaded price rows. `prices` must be ordered by
   * night (use `matchNights`). Kept free of I/O so search can price many plans
   * from a single bulk query instead of one query per plan.
   *
   * Members pay full room price + tax at checkout. Membership benefit is
   * informational `coinEarnPreview` (credited after stay COMPLETED).
   */
  computeQuote(
    prices: RatePriceLike[],
    rooms: number,
    membership?: MembershipPricingContext,
  ): Quote {
    if (!prices.length) {
      throw new BadRequestException('Cannot price a stay with no nights');
    }
    if (!Number.isInteger(rooms) || rooms < 1) {
      throw new BadRequestException('rooms must be a positive integer');
    }

    const nightly: NightlyRate[] = prices.map((price) => ({
      date: price.date,
      basePrice: Number(price.basePrice),
    }));

    const perRoom = nightly.reduce((sum, night) => sum + night.basePrice, 0);
    const subtotal = perRoom * rooms;

    let coinEarnPreview: Quote['coinEarnPreview'];
    if (membership && membership.discountPercent > 0) {
      coinEarnPreview = {
        planCode: membership.planCode,
        earnPercent: membership.discountPercent,
        earnableAmount: Math.round(
          (subtotal * membership.discountPercent) / 100,
        ),
      };
    }

    const taxAmount = this.estimateTaxes(subtotal);
    const totalAmount = subtotal + taxAmount;

    return {
      nightly,
      nights: nightly.length,
      rooms,
      subtotal,
      taxAmount,
      discountAmount: 0,
      totalAmount,
      currency: prices[0].currency ?? DEFAULT_CURRENCY,
      taxRate: TAX_RATE,
      coinEarnPreview,
    };
  }

  /**
   * Applies coin redemption to a quote. Coins reduce room subtotal first; tax is
   * recalculated on the remaining subtotal.
   */
  applyCoinRedemption(quote: Quote, coinsToRedeem: number): Quote {
    if (coinsToRedeem < 0) {
      throw new BadRequestException('coinsToRedeem cannot be negative');
    }
    if (coinsToRedeem === 0) {
      return { ...quote, coinsRedeemed: 0 };
    }

    const maxApplicable = quote.subtotal;
    if (coinsToRedeem > maxApplicable) {
      throw new BadRequestException(
        `Cannot redeem more than ${maxApplicable} coins against this booking`,
      );
    }

    const subtotalAfter = quote.subtotal - coinsToRedeem;
    const taxAmount = this.estimateTaxes(subtotalAfter);
    const totalAmount = subtotalAfter + taxAmount;

    return {
      ...quote,
      taxAmount,
      totalAmount,
      coinsRedeemed: coinsToRedeem,
    };
  }

  /**
   * Enforces the stay-length and arrival/departure restrictions carried on
   * `RatePrice`.
   *
   * These columns are not currently written by the admin panel, so this is a
   * no-op against today's data. It is enforced anyway: the moment an admin
   * starts populating them, an unenforced check would let guests book stays the
   * property has explicitly closed.
   *
   * `prices` must be ordered by night (use `matchNights`).
   */
  assertStayAllowed(prices: RatePriceLike[]): void {
    if (!prices.length) return;

    const nights = prices.length;
    const arrival = prices[0];
    const lastNight = prices[prices.length - 1];

    if (arrival.minStay != null && nights < arrival.minStay) {
      throw new BadRequestException(
        `This rate requires a minimum stay of ${arrival.minStay} night(s)`,
      );
    }
    if (arrival.maxStay != null && nights > arrival.maxStay) {
      throw new BadRequestException(
        `This rate allows a maximum stay of ${arrival.maxStay} night(s)`,
      );
    }
    if (arrival.closedToArrival) {
      throw new BadRequestException(
        'This rate is closed to arrival on the selected check-in date',
      );
    }
    // Departure happens the morning after the final night, so the restriction
    // is carried on that night's row.
    if (lastNight.closedToDeparture) {
      throw new BadRequestException(
        'This rate is closed to departure on the selected check-out date',
      );
    }
  }

  /**
   * Authoritative quote for the booking path. Must be called with the
   * transaction client so the prices read are the ones the reservation is
   * written from.
   */
  async loadAndQuote(
    client: PricingClient,
    ratePlanId: string,
    nights: Date[],
    rooms: number,
    membership?: MembershipPricingContext,
  ): Promise<Quote> {
    const prices = await client.ratePrice.findMany({
      where: { ratePlanId, date: { in: nights } },
      orderBy: { date: 'asc' },
    });

    const ordered = this.matchNights(prices, nights);
    if (!ordered) {
      throw new BadRequestException(
        'This rate plan is not priced for every night of the selected stay',
      );
    }

    this.assertStayAllowed(ordered);
    return this.computeQuote(ordered, rooms, membership);
  }
}
