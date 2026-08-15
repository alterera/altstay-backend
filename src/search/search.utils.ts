export const PRICE_BUCKETS = [
  { id: '500-1000', label: '₹500 - ₹1000', min: 500, max: 1000 },
  { id: '1000-1500', label: '₹1000 - ₹1500', min: 1000, max: 1500 },
  { id: '1500-3000', label: '₹1500 - ₹3000', min: 1500, max: 3000 },
  { id: '3000-4500', label: '₹3000 - ₹4500', min: 3000, max: 4500 },
  { id: '4500-7000', label: '₹4500 - ₹7000', min: 4500, max: 7000 },
  { id: '7000+', label: '₹7000+', min: 7000, max: Infinity },
] as const;

export type SortOption =
  | 'price_asc'
  | 'price_desc'
  | 'rating_asc'
  | 'rating_desc'
  | 'recommended';

export function parsePriceBuckets(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function matchesPriceBucket(
  pricePerNight: number | null,
  bucketIds: string[],
): boolean {
  if (!bucketIds.length) return true;
  if (pricePerNight === null) return false;
  return bucketIds.some((id) => {
    const bucket = PRICE_BUCKETS.find((b) => b.id === id);
    if (!bucket) return false;
    return pricePerNight >= bucket.min && pricePerNight < bucket.max;
  });
}

export function parseCsv(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function estimateTaxes(amount: number): number {
  return Math.round(amount * 0.18);
}
