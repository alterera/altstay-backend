import { Quote } from '../../pricing/pricing.types';

export type SerializedQuote = Omit<Quote, 'nightly'> & {
  nightly: { date: string; basePrice: number }[];
};

export function serializeQuote(quote: Quote): SerializedQuote {
  return {
    ...quote,
    nightly: quote.nightly.map((night) => ({
      date: night.date.toISOString().slice(0, 10),
      basePrice: night.basePrice,
    })),
  };
}

export function deserializeQuote(json: SerializedQuote): Quote {
  return {
    ...json,
    nightly: json.nightly.map((night) => ({
      date: new Date(`${night.date}T00:00:00.000Z`),
      basePrice: night.basePrice,
    })),
  };
}

export type QuoteResponse = {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  currency: string;
  nights: number;
  rooms: number;
  available: boolean;
  remainingRooms: number;
  expiresAt: string;
  coinEarnPreview?: {
    planCode: string;
    earnPercent: number;
    earnableAmount: number;
  };
  coinsRedeemed?: number;
  /** @deprecated No checkout discount — use coinEarnPreview. */
  membershipDiscount?: {
    planCode: string;
    discountPercent: number;
    discountableAmount: number;
    discountAmount: number;
  };
};

export type BookingIntentResponse = {
  quoteToken: string;
  expiresAt: string;
  quote: QuoteResponse;
  coinsBalance?: number;
  maxCoinsRedeemable?: number;
  property: { name: string; slug: string };
  roomType: { id: string; name: string };
  ratePlan: { id: string; name: string };
};
