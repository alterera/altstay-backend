import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AlterCashService } from '../../alter-cash/alter-cash.service';
import { BookingsService } from '../../bookings/bookings.service';
import { BookingInventoryService } from '../../bookings/booking-inventory.service';
import { assertTransition } from '../../bookings/booking-lifecycle';
import { toUtcDateString } from '../../bookings/booking.utils';
import { eachNight, parseIsoDate } from '../admin.utils';
import {
  AdminCancelBookingDto,
  AdminListBookingsQueryDto,
  AdminRefundPaymentDto,
  UpdateAdminBookingDto,
} from './admin-bookings.dto';

const ADMIN_BOOKING_LIST_INCLUDE = {
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
      provider: true,
      status: true,
      amount: true,
      currency: true,
      paymentMethod: true,
      paidAt: true,
      refundRequired: true,
      refundReason: true,
      failureReason: true,
    },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.ReservationInclude;

const ADMIN_BOOKING_DETAIL_INCLUDE = {
  ...ADMIN_BOOKING_LIST_INCLUDE,
  payments: {
    include: {
      refunds: { orderBy: { createdAt: 'desc' as const } },
    },
    orderBy: { createdAt: 'desc' as const },
  },
  statusHistory: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.ReservationInclude;

type ReservationListRow = Prisma.ReservationGetPayload<{
  include: typeof ADMIN_BOOKING_LIST_INCLUDE;
}>;

type ReservationDetailRow = Prisma.ReservationGetPayload<{
  include: typeof ADMIN_BOOKING_DETAIL_INCLUDE;
}>;

@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: BookingInventoryService,
    private readonly alterCash: AlterCashService,
    private readonly bookings: BookingsService,
  ) {}

  async list(query: AdminListBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildListWhere(query);

    const [total, reservations] = await Promise.all([
      this.prisma.reservation.count({ where }),
      this.prisma.reservation.findMany({
        where,
        include: ADMIN_BOOKING_LIST_INCLUDE,
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
    const reservation = await this.findReservation(id);
    return this.toAdminBooking(reservation, { includeHistory: true });
  }

  async update(id: string, dto: UpdateAdminBookingDto) {
    const reservation = await this.findReservation(id);
    const guest = reservation.guests[0];
    if (!guest) {
      throw new BadRequestException('This booking has no guest to update');
    }

    await this.prisma.$transaction(async (tx) => {
      if (
        dto.guestFirstName !== undefined ||
        dto.guestLastName !== undefined ||
        dto.guestPhone !== undefined ||
        dto.guestEmail !== undefined
      ) {
        await tx.guest.update({
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
      }

      if (
        dto.companyName !== undefined ||
        dto.gstin !== undefined ||
        dto.billingAddress !== undefined
      ) {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            ...(dto.companyName !== undefined
              ? { companyName: dto.companyName || null }
              : {}),
            ...(dto.gstin !== undefined ? { gstin: dto.gstin || null } : {}),
            ...(dto.billingAddress !== undefined
              ? { billingAddress: dto.billingAddress || null }
              : {}),
          },
        });
      }
    });

    return this.getById(reservation.id);
  }

  async accept(id: string) {
    const reservation = await this.findReservation(id);
    if (reservation.status !== ReservationStatus.PAYMENT_PENDING) {
      throw new BadRequestException(
        `Cannot accept a booking in ${reservation.status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.inventory.convertHoldsToSold(tx, reservation.id);
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

  async cancel(id: string, dto: AdminCancelBookingDto = {}) {
    const reservation = await this.findReservation(id);
    assertTransition(reservation.status, ReservationStatus.CANCELLED);

    const initiateRefund = dto.initiateRefund !== false;
    const reason = dto.reason?.trim() || 'ADMIN_CANCEL';

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

      if (initiateRefund) {
        const captured = reservation.payments.filter(
          (payment) =>
            payment.status === PaymentStatus.CAPTURED ||
            payment.status === PaymentStatus.PARTIALLY_REFUNDED,
        );
        for (const payment of captured) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              refundRequired: true,
              refundReason: reason,
            },
          });
        }
      }

      await tx.reservationStatusHistory.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: ReservationStatus.CANCELLED,
          reason,
          actor: 'admin',
        },
      });
    });

    return this.getById(reservation.id);
  }

  async refundPayment(id: string, dto: AdminRefundPaymentDto) {
    const reservation = await this.findReservation(id);
    const payment = reservation.payments.find((row) => row.id === dto.paymentId);
    if (!payment) {
      throw new NotFoundException('Payment not found on this booking');
    }

    if (
      payment.status !== PaymentStatus.CAPTURED &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new BadRequestException(
        `Cannot refund a payment in ${payment.status}`,
      );
    }

    const paymentAmount = Number(payment.amount);
    const alreadyRefunded = payment.refunds.reduce(
      (sum, refund) =>
        refund.status === 'COMPLETED' ? sum + Number(refund.amount) : sum,
      0,
    );
    const remaining = paymentAmount - alreadyRefunded;
    if (remaining <= 0) {
      throw new BadRequestException('This payment has no refundable balance');
    }

    const refundAmount = dto.amount ?? remaining;
    if (refundAmount <= 0 || refundAmount > remaining) {
      throw new BadRequestException(
        `Refund amount must be between 0.01 and ${remaining}`,
      );
    }

    const now = new Date();
    const isFullRefund = refundAmount >= remaining;

    await this.prisma.$transaction(async (tx) => {
      await tx.refund.create({
        data: {
          paymentId: payment.id,
          amount: refundAmount,
          reason: dto.reason,
          status: 'COMPLETED',
          processedAt: now,
        },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: isFullRefund
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
          refundRequired: isFullRefund ? false : true,
          refundReason: isFullRefund ? null : dto.reason,
        },
      });

      await tx.reservationStatusHistory.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: reservation.status,
          reason: 'PAYMENT_REFUND',
          actor: 'admin',
          metadata: {
            paymentId: payment.id,
            amount: refundAmount,
            reason: dto.reason,
          },
        },
      });
    });

    return {
      booking: await this.getById(reservation.id),
      refundedAmount: refundAmount,
      warning:
        'Refund recorded in Alterstays. Initiate the Cashfree payout separately if not already done.',
    };
  }

  async markNoShow(id: string, reason = 'ADMIN_NO_SHOW') {
    const reservation = await this.findReservation(id);
    assertTransition(reservation.status, ReservationStatus.NO_SHOW);

    await this.prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.NO_SHOW },
      });
      await tx.reservationStatusHistory.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: ReservationStatus.NO_SHOW,
          reason,
          actor: 'admin',
        },
      });
    });

    return this.getById(reservation.id);
  }

  async complete(id: string) {
    const reservation = await this.findReservation(id);
    const completed = await this.bookings.completeStay(reservation.id);
    if (!completed) {
      throw new BadRequestException(
        `Cannot complete a booking in ${reservation.status}`,
      );
    }
    return this.getById(reservation.id);
  }

  async remove(id: string) {
    const reservation = await this.findReservation(id);
    const hasCapturedPayment = reservation.payments.some(
      (payment) =>
        payment.status === PaymentStatus.CAPTURED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED,
    );

    if (
      reservation.status !== ReservationStatus.CANCELLED &&
      reservation.status !== ReservationStatus.EXPIRED &&
      reservation.status !== ReservationStatus.NO_SHOW
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

  private buildListWhere(
    query: AdminListBookingsQueryDto,
  ): Prisma.ReservationWhereInput {
    const where: Prisma.ReservationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.propertyId ? { propertyId: query.propertyId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };

    if (query.q?.trim()) {
      where.reservationNumber = {
        contains: query.q.trim(),
        mode: 'insensitive',
      };
    }

    if (query.checkInFrom || query.checkInTo) {
      where.checkIn = {
        ...(query.checkInFrom ? { gte: parseIsoDate(query.checkInFrom) } : {}),
        ...(query.checkInTo ? { lte: parseIsoDate(query.checkInTo) } : {}),
      };
    }

    if (query.refundRequired === true) {
      where.payments = { some: { refundRequired: true } };
    } else if (query.refundRequired === false) {
      where.payments = { none: { refundRequired: true } };
    }

    return where;
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

  private async findReservation(id: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { OR: [{ id }, { reservationNumber: id }] },
      include: ADMIN_BOOKING_DETAIL_INCLUDE,
    });
    if (!reservation) throw new NotFoundException('Booking not found');
    return reservation;
  }

  private toAdminBooking(
    reservation: ReservationListRow | ReservationDetailRow,
    options: { includeHistory?: boolean } = {},
  ) {
    const guest = reservation.guests[0];
    return {
      id: reservation.id,
      reservationNumber: reservation.reservationNumber,
      status: reservation.status,
      checkIn: toUtcDateString(reservation.checkIn),
      checkOut: toUtcDateString(reservation.checkOut),
      subtotal: Number(reservation.subtotal),
      taxAmount: Number(reservation.taxAmount),
      discountAmount: Number(reservation.discountAmount),
      totalAmount: Number(reservation.totalAmount),
      currency: reservation.currency,
      coinsRedeemed: Number(reservation.coinsRedeemed),
      coinsEarnable: Number(reservation.coinsEarnable),
      coinsEarnedAt: reservation.coinsEarnedAt?.toISOString() ?? null,
      companyName: reservation.companyName,
      gstin: reservation.gstin,
      billingAddress: reservation.billingAddress,
      createdAt: reservation.createdAt.toISOString(),
      updatedAt: reservation.updatedAt.toISOString(),
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
        id: item.id,
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
      })),
      payments: reservation.payments.map((payment) => ({
        id: payment.id,
        paymentReference: payment.paymentReference,
        provider: payment.provider,
        status: payment.status,
        amount: Number(payment.amount),
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        paidAt: payment.paidAt?.toISOString() ?? null,
        refundRequired: payment.refundRequired,
        refundReason: payment.refundReason,
        failureReason: payment.failureReason,
        refunds:
          'refunds' in payment
            ? payment.refunds.map((refund) => ({
                id: refund.id,
                amount: Number(refund.amount),
                reason: refund.reason,
                status: refund.status,
                providerRefundId: refund.providerRefundId,
                createdAt: refund.createdAt.toISOString(),
                processedAt: refund.processedAt?.toISOString() ?? null,
              }))
            : [],
      })),
      statusHistory:
        options.includeHistory && 'statusHistory' in reservation
          ? reservation.statusHistory.map((entry) => ({
            id: entry.id,
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            reason: entry.reason,
            actor: entry.actor,
            metadata: entry.metadata,
            createdAt: entry.createdAt.toISOString(),
          }))
        : undefined,
    };
  }
}
