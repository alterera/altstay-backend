/**
 * Renders a UTC calendar date as `yyyy-MM-dd`.
 *
 * Inventory and rate rows use PostgreSQL `DATE`, which has no timezone. Passing
 * JS `Date` objects into raw SQL would let the driver's timezone handling shift a
 * night by one day, so raw queries bind date strings and cast them explicitly.
 */
export function toUtcDateString(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
