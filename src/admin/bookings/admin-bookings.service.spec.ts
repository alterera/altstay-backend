import { BadRequestException } from '@nestjs/common';
import { PaymentStatus, ReservationStatus } from '../../prisma/client';
import { AdminBookingsService } from './admin-bookings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingInventoryService } from '../../bookings/booking-inventory.service';
import { AlterCashService } from '../../alter-cash/alter-cash.service';
import { BookingsService } from '../../bookings/bookings.service';

describe('AdminBookingsService', () => {
  let service: AdminBookingsService;
  let prisma: {
    reservation: {
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    payment: { update: jest.Mock };
    refund: { create: jest.Mock };
    reservationStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let inventory: { releaseHolds: jest.Mock; convertHoldsToSold: jest.Mock };
  let alterCash: { refundRedemption: jest.Mock };
  let bookings: { completeStay: jest.Mock };

  const baseReservation = {
    id: 'res-1',
    reservationNumber: 'ALT-001',
    status: ReservationStatus.CONFIRMED,
    checkIn: new Date('2026-09-01'),
    checkOut: new Date('2026-09-03'),
    subtotal: 1000,
    taxAmount: 180,
    discountAmount: 0,
    totalAmount: 1180,
    currency: 'INR',
    coinsRedeemed: 0,
    coinsEarnable: 50,
    coinsEarnedAt: null,
    companyName: null,
    gstin: null,
    billingAddress: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    holdExpiresAt: null,
    confirmedAt: new Date(),
    property: { id: 'p-1', name: 'Hotel', slug: 'hotel' },
    user: {
      id: 'u-1',
      phone: '+911234567890',
      firstName: 'Test',
      lastName: 'User',
      email: null,
    },
    items: [
      {
        id: 'item-1',
        roomTypeId: 'rt-1',
        quantity: 1,
        checkIn: new Date('2026-09-01'),
        checkOut: new Date('2026-09-03'),
        roomTypeName: 'Deluxe',
        ratePlanName: 'Room only',
        mealPlanName: null,
        cancellationPolicyText: null,
        unitPrice: 1000,
        subtotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
      },
    ],
    guests: [
      {
        id: 'g-1',
        firstName: 'Guest',
        lastName: 'One',
        phone: null,
        email: null,
      },
    ],
    payments: [
      {
        id: 'pay-1',
        paymentReference: 'PAY-1',
        provider: 'CASHFREE',
        status: PaymentStatus.CAPTURED,
        amount: 1180,
        currency: 'INR',
        paymentMethod: 'UPI',
        paidAt: new Date(),
        refundRequired: false,
        refundReason: null,
        failureReason: null,
        refunds: [],
      },
    ],
    statusHistory: [],
  };

  beforeEach(() => {
    prisma = {
      reservation: {
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      payment: { update: jest.fn() },
      refund: { create: jest.fn() },
      reservationStatusHistory: { create: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          reservation: prisma.reservation,
          payment: prisma.payment,
          refund: prisma.refund,
          reservationStatusHistory: prisma.reservationStatusHistory,
          $executeRaw: jest.fn(),
        }),
      ),
    };
    inventory = {
      releaseHolds: jest.fn(),
      convertHoldsToSold: jest.fn(),
    };
    alterCash = { refundRedemption: jest.fn() };
    bookings = { completeStay: jest.fn() };

    service = new AdminBookingsService(
      prisma as unknown as PrismaService,
      inventory as unknown as BookingInventoryService,
      alterCash as unknown as AlterCashService,
      bookings as unknown as BookingsService,
    );
  });

  describe('cancel', () => {
    it('flags captured payments for refund by default', async () => {
      prisma.reservation.findFirst
        .mockResolvedValueOnce(baseReservation)
        .mockResolvedValueOnce({
          ...baseReservation,
          status: ReservationStatus.CANCELLED,
        });

      await service.cancel('res-1', { reason: 'Guest request' });

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refundRequired: true,
            refundReason: 'Guest request',
          }),
        }),
      );
      expect(alterCash.refundRedemption).toHaveBeenCalled();
    });
  });

  describe('refundPayment', () => {
    it('records a full refund and updates payment status', async () => {
      prisma.reservation.findFirst
        .mockResolvedValueOnce(baseReservation)
        .mockResolvedValueOnce({
          ...baseReservation,
          payments: [
            {
              ...baseReservation.payments[0],
              refunds: [
                {
                  id: 'ref-1',
                  amount: 1180,
                  reason: 'Guest request',
                  status: 'COMPLETED',
                  providerRefundId: null,
                  createdAt: new Date(),
                  processedAt: new Date(),
                },
              ],
            },
          ],
        });

      const result = await service.refundPayment('res-1', {
        paymentId: 'pay-1',
        reason: 'Guest request',
      });

      expect(prisma.refund.create).toHaveBeenCalled();
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.REFUNDED }),
        }),
      );
      expect(result.refundedAmount).toBe(1180);
    });

    it('rejects refund when payment is not captured', async () => {
      prisma.reservation.findFirst.mockResolvedValue({
        ...baseReservation,
        payments: [
          { ...baseReservation.payments[0], status: PaymentStatus.PENDING },
        ],
      });

      await expect(
        service.refundPayment('res-1', {
          paymentId: 'pay-1',
          reason: 'Test',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
