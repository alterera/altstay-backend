import {
  buildBookingTabWhere,
  startOfTodayUtc,
} from '../booking-list.filters';

describe('buildBookingTabWhere', () => {
  const today = startOfTodayUtc(new Date('2026-08-22T15:00:00.000Z'));

  it('pending matches unpaid future stays', () => {
    expect(buildBookingTabWhere('pending', today)).toEqual({
      status: 'PAYMENT_PENDING',
      checkOut: { gt: today },
    });
  });

  it('ongoing matches confirmed stays in progress', () => {
    expect(buildBookingTabWhere('ongoing', today)).toEqual({
      status: 'CONFIRMED',
      checkIn: { lte: today },
      checkOut: { gt: today },
    });
  });

  it('upcoming matches only future confirmed stays', () => {
    expect(buildBookingTabWhere('upcoming', today)).toEqual({
      status: 'CONFIRMED',
      checkIn: { gt: today },
    });
  });

  it('cancelled matches terminal cancelled statuses', () => {
    expect(buildBookingTabWhere('cancelled', today)).toEqual({
      status: {
        in: ['CANCELLED', 'EXPIRED', 'NO_SHOW'],
      },
    });
  });
});
