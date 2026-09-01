import { Prisma } from '../prisma/client';

/**
 * Minimal shape of a `RatePrice` row needed to build a quote. Loosened from the
 * generated model so callers can pass rows selected with a partial `select`.
 */
export type RatePriceLike = {
  date: Date;
  basePrice: Prisma.Decimal | number | string;
  currency?: string;
  minStay?: number | null;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
};

export type NightlyRate = {
  date: Date;
  basePrice: number;
};

/** @deprecated Checkout no longer applies membership discounts — use coinEarnPreview. */
export type MembershipDiscount = {
  planCode: string;
  discountPercent: number;
  discountableAmount: number;
  discountAmount: number;
};

export type CoinEarnPreview = {
  planCode: string;
  earnPercent: number;
  earnableAmount: number;
};

export type Quote = {
  nightly: NightlyRate[];
  nights: number;
  rooms: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  currency: string;
  taxRate: number;
  /** @deprecated Always 0 at checkout; kept for backward-compatible snapshots. */
  membershipDiscount?: MembershipDiscount;
  coinEarnPreview?: CoinEarnPreview;
  coinsRedeemed?: number;
};

export type PricingClient = Prisma.TransactionClient;

export type MembershipPricingContext = {
  planCode: string;
  discountPercent: number;
};
