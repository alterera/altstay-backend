import { Prisma, ReservationStatus } from '../prisma/client';

export const BOOKING_LIST_TABS = [
  'pending',
  'ongoing',
  'upcoming',
  'cancelled',
] as const;
export type BookingListTab = (typeof BOOKING_LIST_TABS)[number];

export function startOfTodayUtc(from = new Date()): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
}

export function buildBookingTabWhere(
  tab: BookingListTab,
  today = startOfTodayUtc(),
): Prisma.ReservationWhereInput {
  const cancelledStatuses: ReservationStatus[] = [
    ReservationStatus.CANCELLED,
    ReservationStatus.EXPIRED,
    ReservationStatus.NO_SHOW,
  ];

  switch (tab) {
    case 'pending':
      return {
        status: ReservationStatus.PAYMENT_PENDING,
        checkOut: { gt: today },
      };

    case 'ongoing':
      return {
        status: ReservationStatus.CONFIRMED,
        checkIn: { lte: today },
        checkOut: { gt: today },
      };

    case 'upcoming':
      return {
        status: ReservationStatus.CONFIRMED,
        checkIn: { gt: today },
      };

    case 'cancelled':
      return {
        status: { in: cancelledStatuses },
      };
  }
}
