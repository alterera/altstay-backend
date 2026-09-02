import { BadRequestException } from '@nestjs/common';

const DEFAULT_ORG_ID = '00000000-0000-4000-8000-000000000001';

export const MAX_ADMIN_DATE_RANGE_NIGHTS = 366;

export function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function eachNight(start: string, end: string): Date[] {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  const nights: Date[] = [];
  const cursor = new Date(startDate);
  while (cursor < endDate) {
    nights.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

/** Validates a half-open [start, end) date range and caps bulk admin writes. */
export function assertDateRange(start: string, end: string): Date[] {
  const nights = eachNight(start, end);
  if (nights.length === 0) {
    throw new BadRequestException(
      'Date range must include at least one night (end date must be after start date)',
    );
  }
  if (nights.length > MAX_ADMIN_DATE_RANGE_NIGHTS) {
    throw new BadRequestException(
      `Date range cannot exceed ${MAX_ADMIN_DATE_RANGE_NIGHTS} nights`,
    );
  }
  return nights;
}

export function defaultInventoryRange(): { from: string; to: string } {
  const from = new Date();
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 90);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export { DEFAULT_ORG_ID };
