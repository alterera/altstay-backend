import {
  buildBookingTabWhere,
  startOfTodayUtc,
} from '../booking-list.filters';

describe('buildBookingTabWhere', () => {
  const today = startOfTodayUtc(new Date('2026-08-22T15:00:00.000Z'));

  it('ongoing matches confirmed stays in progress', () => {
    expect(buildBookingTabWhere('ongoing', today)).toEqual({
      status: 'CONFIRMED',
      checkIn: { lte: today },
      checkOut: { gt: today },
    });
  });

  it('cancelled matches terminal cancelled statuses', () => {
    expect(buildBookingTabWhere('cancelled', today)).toEqual({
      status: {
        in: ['CANCELLED', 'EXPIRED', 'NO_SHOW'],
      },
    });
  });

  it('upcoming excludes ongoing confirmed stays', () => {
    const where = buildBookingTabWhere('upcoming', today);
    expect(where).toMatchObject({
      checkOut: { gt: today },
    });
    expect(where.NOT).toBeDefined();
  });
});
