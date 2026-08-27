import { Prisma } from '../../prisma/client';
import { toUtcDateString } from '../booking.utils';
import { selectPayment } from './payment-summary';

export const BOOKING_INCLUDE = {
  property: {
    select: {
      id: true,
      name: true,
      slug: true,
      images: {
        select: { url: true },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
      addresses: {
        select: { city: true, latitude: true, longitude: true },
        take: 1,
      },
    },
  },
  items: true,
  guests: true,
  payments: {
    select: {
      paymentReference: true,
      status: true,
      paidAt: true,
      refundRequired: true,
      failureReason: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ReservationInclude;

export type BookingRecord = Prisma.ReservationGetPayload<{
  include: typeof BOOKING_INCLUDE;
}>;

/**
 * Public shape of a booking. Dates are emitted as `yyyy-MM-dd` because check-in
 * and check-out are calendar dates, not instants — sending a timestamp invites
 * the client to shift them by its own timezone.
 */
export function toBookingResponse(reservation: BookingRecord) {
  const nights = Math.round(
    (reservation.checkOut.getTime() - reservation.checkIn.getTime()) /
      (24 * 60 * 60 * 1000),
  );

  return {
    reservationNumber: reservation.reservationNumber,
    status: reservation.status,
    property: {
      name: reservation.property.name,
      slug: reservation.property.slug,
      city: reservation.property.addresses[0]?.city ?? null,
      imageUrl: reservation.property.images[0]?.url ?? null,
      latitude: reservation.property.addresses[0]?.latitude
        ? Number(reservation.property.addresses[0].latitude)
        : null,
      longitude: reservation.property.addresses[0]?.longitude
        ? Number(reservation.property.addresses[0].longitude)
        : null,
    },
    checkIn: toUtcDateString(reservation.checkIn),
    checkOut: toUtcDateString(reservation.checkOut),
    nights,
    currency: reservation.currency,
    subtotal: Number(reservation.subtotal),
    taxAmount: Number(reservation.taxAmount),
    discountAmount: Number(reservation.discountAmount),
    totalAmount: Number(reservation.totalAmount),
    holdExpiresAt: reservation.holdExpiresAt?.toISOString() ?? null,
    confirmedAt: reservation.confirmedAt?.toISOString() ?? null,
    createdAt: reservation.createdAt.toISOString(),
    payment: selectPayment(reservation.status, reservation.payments),
    businessBooking: reservation.companyName
      ? {
          companyName: reservation.companyName,
          gstin: reservation.gstin,
          billingAddress: reservation.billingAddress,
        }
      : null,
    guests: reservation.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      email: guest.email,
      phone: guest.phone,
    })),
    items: reservation.items.map((item) => ({
      roomTypeId: item.roomTypeId,
      ratePlanId: item.ratePlanId,
      roomTypeName: item.roomTypeName,
      ratePlanName: item.ratePlanName,
      mealPlanName: item.mealPlanName,
      cancellationPolicyText: item.cancellationPolicyText,
      quantity: item.quantity,
      checkIn: toUtcDateString(item.checkIn),
      checkOut: toUtcDateString(item.checkOut),
      unitPrice: Number(item.unitPrice),
      subtotal: Number(item.subtotal),
      taxAmount: Number(item.taxAmount),
      totalAmount: Number(item.totalAmount),
      snapshot: item.snapshotJson,
    })),
  };
}

export type BookingResponse = ReturnType<typeof toBookingResponse>;
