import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AlterCashTransactionType,
  Prisma,
  ReservationStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AlterCashHistoryPage = {
  items: {
    id: string;
    type: AlterCashTransactionType;
    amount: number;
    balanceAfter: number;
    description: string;
    reservationId: string | null;
    createdAt: string;
  }[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

@Injectable()
export class AlterCashService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { alterCashBalance: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return Number(user.alterCashBalance);
  }

  async getHistory(
    userId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<AlterCashHistoryPage> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      this.prisma.alterCashTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.alterCashTransaction.count({ where: { userId } }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        amount: Number(row.amount),
        balanceAfter: Number(row.balanceAfter),
        description: row.description,
        reservationId: row.reservationId,
        createdAt: row.createdAt.toISOString(),
      })),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    };
  }

  previewRedemption(
    balance: number,
    roomSubtotal: number,
    coinsToApply: number,
  ): { valid: boolean; applied: number; reason?: string } {
    if (coinsToApply < 0) {
      return { valid: false, applied: 0, reason: 'Coins cannot be negative' };
    }
    if (coinsToApply === 0) {
      return { valid: true, applied: 0 };
    }
    const maxApplicable = Math.min(balance, roomSubtotal);
    if (coinsToApply > maxApplicable) {
      return {
        valid: false,
        applied: 0,
        reason: `You can apply at most ${maxApplicable} coins for this booking`,
      };
    }
    return { valid: true, applied: coinsToApply };
  }

  async redeemForBooking(
    tx: Prisma.TransactionClient,
    userId: string,
    reservationId: string,
    amount: number,
    reservationNumber: string,
  ): Promise<void> {
    if (amount <= 0) return;

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { alterCashBalance: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const balance = Number(user.alterCashBalance);
    if (amount > balance) {
      throw new BadRequestException('Insufficient coin balance');
    }

    const balanceAfter = balance - amount;
    await tx.user.update({
      where: { id: userId },
      data: { alterCashBalance: balanceAfter },
    });

    await tx.alterCashTransaction.create({
      data: {
        userId,
        type: AlterCashTransactionType.REDEEM,
        amount: -amount,
        balanceAfter,
        reservationId,
        description: `Coins redeemed — Booking #${reservationNumber}`,
      },
    });
  }

  async refundRedemption(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ): Promise<void> {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        userId: true,
        reservationNumber: true,
        coinsRedeemed: true,
        status: true,
      },
    });
    if (!reservation) return;

    const redeemed = Number(reservation.coinsRedeemed);
    if (redeemed <= 0) return;

    const existingRefund = await tx.alterCashTransaction.findFirst({
      where: {
        reservationId,
        type: AlterCashTransactionType.REDEEM_REFUND,
      },
    });
    if (existingRefund) return;

    const user = await tx.user.findUnique({
      where: { id: reservation.userId },
      select: { alterCashBalance: true },
    });
    if (!user) return;

    const balanceAfter = Number(user.alterCashBalance) + redeemed;
    await tx.user.update({
      where: { id: reservation.userId },
      data: { alterCashBalance: balanceAfter },
    });

    await tx.alterCashTransaction.create({
      data: {
        userId: reservation.userId,
        type: AlterCashTransactionType.REDEEM_REFUND,
        amount: redeemed,
        balanceAfter,
        reservationId,
        description: `Coins refunded — Booking #${reservation.reservationNumber}`,
      },
    });
  }

  async creditEarnOnComplete(reservationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          userId: true,
          reservationNumber: true,
          status: true,
          coinsEarnable: true,
          coinsEarnedAt: true,
        },
      });

      if (
        !reservation ||
        reservation.status !== ReservationStatus.COMPLETED ||
        reservation.coinsEarnedAt
      ) {
        return false;
      }

      const earnable = Number(reservation.coinsEarnable);
      if (earnable <= 0) {
        await tx.reservation.update({
          where: { id: reservationId },
          data: { coinsEarnedAt: new Date() },
        });
        return false;
      }

      const existingEarn = await tx.alterCashTransaction.findFirst({
        where: {
          reservationId,
          type: AlterCashTransactionType.EARN,
        },
      });
      if (existingEarn) return false;

      const activeMembership = await tx.userMembership.findFirst({
        where: {
          userId: reservation.userId,
          status: 'ACTIVE',
        },
        orderBy: { activatedAt: 'desc' },
        select: { id: true },
      });

      const user = await tx.user.findUnique({
        where: { id: reservation.userId },
        select: { alterCashBalance: true },
      });
      if (!user) return false;

      const balanceAfter = Number(user.alterCashBalance) + earnable;
      const now = new Date();

      await tx.user.update({
        where: { id: reservation.userId },
        data: { alterCashBalance: balanceAfter },
      });

      await tx.alterCashTransaction.create({
        data: {
          userId: reservation.userId,
          type: AlterCashTransactionType.EARN,
          amount: earnable,
          balanceAfter,
          reservationId,
          userMembershipId: activeMembership?.id ?? null,
          description: `Coins earned — Booking #${reservation.reservationNumber}`,
        },
      });

      await tx.reservation.update({
        where: { id: reservationId },
        data: { coinsEarnedAt: now },
      });

      return true;
    });
  }

  async adjustBalance(
    userId: string,
    amount: number,
    reason: string,
  ): Promise<number> {
    if (!reason.trim()) {
      throw new BadRequestException('Adjustment reason is required');
    }
    if (amount === 0) {
      throw new BadRequestException('Adjustment amount cannot be zero');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { alterCashBalance: true },
      });
      if (!user) throw new NotFoundException('User not found');

      const balance = Number(user.alterCashBalance);
      const balanceAfter = balance + amount;
      if (balanceAfter < 0) {
        throw new BadRequestException('Adjustment would make balance negative');
      }

      await tx.user.update({
        where: { id: userId },
        data: { alterCashBalance: balanceAfter },
      });

      await tx.alterCashTransaction.create({
        data: {
          userId,
          type: AlterCashTransactionType.ADJUST,
          amount,
          balanceAfter,
          description: reason.trim(),
        },
      });

      return balanceAfter;
    });
  }
}
