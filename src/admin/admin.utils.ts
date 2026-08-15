const DEFAULT_ORG_ID = '00000000-0000-4000-8000-000000000001';

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

export { DEFAULT_ORG_ID };
