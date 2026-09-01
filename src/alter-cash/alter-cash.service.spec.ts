import { BadRequestException } from '@nestjs/common';
import { AlterCashService } from './alter-cash.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AlterCashService', () => {
  let service: AlterCashService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    alterCashTransaction: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
    reservation: { findUnique: jest.Mock; update: jest.Mock };
    userMembership: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      alterCashTransaction: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn(),
      },
      reservation: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      userMembership: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn((fn) => fn(prisma)),
    };

    service = new AlterCashService(prisma as unknown as PrismaService);
  });

  describe('previewRedemption', () => {
    it('caps redemption at balance and room subtotal', () => {
      expect(service.previewRedemption(200, 3000, 150)).toEqual({
        valid: true,
        applied: 150,
      });
      expect(service.previewRedemption(100, 3000, 150).valid).toBe(false);
      expect(service.previewRedemption(500, 300, 400).valid).toBe(false);
    });
  });

  describe('redeemForBooking', () => {
    it('debits balance and writes REDEEM ledger row', async () => {
      prisma.user.findUnique.mockResolvedValue({ alterCashBalance: 500 });

      await service.redeemForBooking(
        prisma as never,
        'user-1',
        'res-1',
        200,
        'AS-100',
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { alterCashBalance: 300 },
      });
      expect(prisma.alterCashTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'REDEEM',
            amount: -200,
            balanceAfter: 300,
          }),
        }),
      );
    });

    it('rejects insufficient balance', async () => {
      prisma.user.findUnique.mockResolvedValue({ alterCashBalance: 50 });
      await expect(
        service.redeemForBooking(
          prisma as never,
          'user-1',
          'res-1',
          200,
          'AS-100',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('refundRedemption', () => {
    it('credits redeemed coins once', async () => {
      prisma.reservation.findUnique.mockResolvedValue({
        id: 'res-1',
        userId: 'user-1',
        reservationNumber: 'AS-100',
        coinsRedeemed: 150,
        status: 'EXPIRED',
      });
      prisma.alterCashTransaction.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ alterCashBalance: 100 });

      await service.refundRedemption(prisma as never, 'res-1');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { alterCashBalance: 250 },
      });
      expect(prisma.alterCashTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'REDEEM_REFUND',
            amount: 150,
          }),
        }),
      );
    });
  });
});
