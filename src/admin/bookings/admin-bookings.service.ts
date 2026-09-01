import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReservationStatus } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingInventoryService } from '../../bookings/booking-inventory.service';
import { AlterCashService } from '../../alter-cash/alter-cash.service';
import { eachNight } from '../admin.utils';
import { toUtcDateString } from '../../bookings/booking.utils';
import { assertTransition } from '../../bookings/booking-lifecycle';
import { UpdateAdminBookingDto } from '../dto/admin.dto';
import { ListBookingsQueryDto } from '../../bookings/dto/list-bookings-query.dto';

const ADMIN_BOOKING_INCLUDE = {
  property: { select: { id: true, name: true, slug: true } },
  user: {
    select: {
      id: true,
      phone: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  items: true,
  guests: true,
  payments: {
    select: {
      id: true,
      paymentReference: true,
      status: true,
      amount: true,
      paidAt: true,
      refundRequired: true,
    },
  },
} satisfies Prisma.ReservationInclude;

@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: BookingInventoryService,
    private readonly alterCash: AlterCashService,
  ) {}

  async list(query: ListBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ReservationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };

    const [total, reservations] = await Promise.all([
      this.prisma.reservation.count({ where }),
      this.prisma.reservation.findMany({
        where,
        include: ADMIN_BOOKING_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      results: reservations.map((row) => this.toAdminBooking(row)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    };
  }

  async getById(id: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        OR: [{ id }, { reservationNumber: id }],
      },
      include: ADMIN_BOOKING_INCLUDE,
    });
    if (!reservation) throw new NotFoundException('Booking not found');
    return this.toAdminBooking(reservation);
  }

  async update(id: string, dto: UpdateAdminBookingDto) {
    const reservation = await this.requireReservation(id);
    const guest = reservation.guests[0];
    if (!guest) {
      throw new BadRequestException('This booking has no guest to update');
    }

    await this.prisma.guest.update({
      where: { id: guest.id },
      data: {
        ...(dto.guestFirstName !== undefined
          ? { firstName: dto.guestFirstName }
          : {}),
        ...(dto.guestLastName !== undefined
          ? { lastName: dto.guestLastName }
          : {}),
        ...(dto.guestPhone !== undefined ? { phone: dto.guestPhone } : {}),
        ...(dto.guestEmail !== undefined ? { email: dto.guestEmail } : {}),
      },
    });

    return this.getById(reservation.id);
  }

  async accept(id: string) {
    const reservation = await this.requireReservation(id);
    if (reservation.status !== ReservationStatus.PAYMENT_PENDING) {
      throw new BadRequestException(
        `Cannot accept a booking in ${reservation.status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (reservation.status === ReservationStatus.PAYMENT_PENDING) {
        await this.inventory.convertHoldsToSold(tx, reservation.id);
      }
      assertTransition(reservation.status, ReservationStatus.CONFIRMED);
      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.CONFIRMED,
          confirmedAt: new Date(),
          holdExpiresAt: null,
        },
      });
      await tx.reservationStatusHistory.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: ReservationStatus.CONFIRMED,
          reason: 'ADMIN_ACCEPT',
          actor: 'admin',
        },
      });
    });

    return this.getById(reservation.id);
  }

  async cancel(id: string) {
    const reservation = await this.requireReservation(id);
    assertTransition(reservation.status, ReservationStatus.CANCELLED);

    await this.prisma.$transaction(async (tx) => {
      if (reservation.status === ReservationStatus.PAYMENT_PENDING) {
        await this.inventory.releaseHolds(tx, reservation.id);
      }
      if (reservation.status === ReservationStatus.CONFIRMED) {
        await this.restoreSoldRooms(tx, reservation.items);
      }
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.CANCELLED, holdExpiresAt: null },
      });
      await this.alterCash.refundRedemption(tx, reservation.id);
      await tx.reservationStatusHistory.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: ReservationStatus.CANCELLED,
          reason: 'ADMIN_CANCEL',
          actor: 'admin',
        },
      });
    });

    return this.getById(reservation.id);
  }

  async remove(id: string) {
    const reservation = await this.requireReservation(id);
    const hasCapturedPayment = reservation.payments.some(
      (payment) => payment.status === 'CAPTURED',
    );

    if (
      reservation.status !== ReservationStatus.CANCELLED &&
      reservation.status !== ReservationStatus.EXPIRED
    ) {
      await this.cancel(reservation.id);
    }

    if (hasCapturedPayment) {
      return {
        success: true,
        deleted: false,
        message:
          'Booking was cancelled. Captured payments keep the reservation on file.',
      };
    }

    await this.prisma.reservation.delete({ where: { id: reservation.id } });
    return { success: true, deleted: true };
  }

  private async restoreSoldRooms(
    tx: Prisma.TransactionClient,
    items: Array<{
      roomTypeId: string;
      quantity: number;
      checkIn: Date;
      checkOut: Date;
    }>,
  ) {
    for (const item of items) {
      const nights = eachNight(
        toUtcDateString(item.checkIn),
        toUtcDateString(item.checkOut),
      );
      if (!nights.length) continue;
      const dateList = Prisma.join(
        nights.map((date) => Prisma.sql`${toUtcDateString(date)}::date`),
      );
      await tx.$executeRaw`
        UPDATE "room_inventory"
        SET "soldRooms" = GREATEST("soldRooms" - ${item.quantity}, 0)
        WHERE "roomTypeId" = ${item.roomTypeId}::uuid
          AND "date" IN (${dateList})
      `;
    }
  }

  private async requireReservation(id: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { OR: [{ id }, { reservationNumber: id }] },
      include: ADMIN_BOOKING_INCLUDE,
    });
    if (!reservation) throw new NotFoundException('Booking not found');
    return reservation;
  }

  private toAdminBooking(
    reservation: Prisma.ReservationGetPayload<{
      include: typeof ADMIN_BOOKING_INCLUDE;
    }>,
  ) {
    const guest = reservation.guests[0];
    return {
      id: reservation.id,
      reservationNumber: reservation.reservationNumber,
      status: reservation.status,
      checkIn: toUtcDateString(reservation.checkIn),
      checkOut: toUtcDateString(reservation.checkOut),
      totalAmount: Number(reservation.totalAmount),
      currency: reservation.currency,
      createdAt: reservation.createdAt.toISOString(),
      holdExpiresAt: reservation.holdExpiresAt?.toISOString() ?? null,
      confirmedAt: reservation.confirmedAt?.toISOString() ?? null,
      property: reservation.property,
      user: reservation.user,
      guest: guest
        ? {
            firstName: guest.firstName,
            lastName: guest.lastName,
            phone: guest.phone,
            email: guest.email,
          }
        : null,
      items: reservation.items.map((item) => ({
        roomTypeName: item.roomTypeName,
        ratePlanName: item.ratePlanName,
        quantity: item.quantity,
      })),
      payments: reservation.payments,
    };
  }
}
