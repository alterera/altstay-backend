import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MembershipPlan,
  MembershipPurchaseStatus,
  Prisma,
  ReservationStatus,
  UserMembershipStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActiveMembership,
  MembershipExpiryCalculation,
  UpgradePreview,
} from './membership.types';
import {
  calculateRenewalExpiry,
  calculateUpgradeExpiry,
  daysBetween,
  planDailyRate,
} from './membership.utils';

@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivePlans(): Promise<MembershipPlan[]> {
    return this.prisma.membershipPlan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  async getPlanByCode(planCode: string): Promise<MembershipPlan> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { code: planCode, isActive: true },
    });
    if (!plan) {
      throw new NotFoundException(`Membership plan "${planCode}" not found`);
    }
    return plan;
  }

  async getActiveMembership(userId: string): Promise<ActiveMembership | null> {
    const now = new Date();
    const membership = await this.prisma.userMembership.findFirst({
      where: {
        userId,
        status: UserMembershipStatus.ACTIVE,
        expiresAt: { gt: now },
      },
      include: { plan: true },
      orderBy: { activatedAt: 'desc' },
    });

    if (!membership) return null;

    return {
      membership,
      plan: membership.plan,
      planCode: membership.plan.code,
      discountPercent: membership.plan.discountPercent,
    };
  }

  async getUpgradePreview(
    userId: string,
    planCode: string,
  ): Promise<UpgradePreview> {
    const plan = await this.getPlanByCode(planCode);
    const active = await this.getActiveMembership(userId);
    const now = new Date();

    const calc = calculateUpgradeExpiry(
      now,
      plan,
      active
        ? {
            expiresAt: active.membership.expiresAt,
            plan: active.plan,
          }
        : null,
    );

    const remainingValue =
      active && active.membership.expiresAt > now
        ? daysBetween(now, active.membership.expiresAt) *
          planDailyRate(active.plan)
        : 0;

    return {
      planCode: plan.code,
      planName: plan.name,
      price: Number(plan.price),
      purchasedDays: plan.durationDays,
      bonusDays: calc.upgradeCreditDays ?? 0,
      totalDays: plan.durationDays + (calc.upgradeCreditDays ?? 0),
      remainingValue: Math.round(remainingValue * 100) / 100,
      expiresAt: calc.expiresAt.toISOString(),
    };
  }

  computeExpiryForPurchase(
    userId: string,
    newPlan: MembershipPlan,
    active: ActiveMembership | null,
    now = new Date(),
  ): MembershipExpiryCalculation {
    if (!active) {
      return {
        expiresAt: calculateRenewalExpiry(now, newPlan),
        upgradeCreditDays: null,
        upgradeCreditValue: null,
      };
    }

    if (active.plan.code === newPlan.code) {
      return {
        expiresAt: calculateRenewalExpiry(
          now,
          newPlan,
          active.membership.expiresAt,
        ),
        upgradeCreditDays: null,
        upgradeCreditValue: null,
      };
    }

    return calculateUpgradeExpiry(now, newPlan, {
      expiresAt: active.membership.expiresAt,
      plan: active.plan,
    });
  }

  async syncUserProfileFields(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const active = await tx.userMembership.findFirst({
      where: {
        userId,
        status: UserMembershipStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      include: { plan: true },
      orderBy: { activatedAt: 'desc' },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        membershipTier: active?.plan.name ?? 'Free',
        membershipExpiresAt: active?.expiresAt ?? null,
      },
    });
  }

  async expireStaleMemberships(now = new Date()): Promise<number> {
    const result = await this.prisma.userMembership.updateMany({
      where: {
        status: UserMembershipStatus.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: UserMembershipStatus.EXPIRED },
    });

    if (result.count > 0) {
      const affectedUsers = await this.prisma.userMembership.findMany({
        where: {
          status: UserMembershipStatus.EXPIRED,
          expiresAt: { lte: now },
        },
        select: { userId: true },
        distinct: ['userId'],
      });

      for (const { userId } of affectedUsers) {
        await this.syncUserProfileFields(this.prisma, userId);
      }
    }

    return result.count;
  }

  async expireAbandonedPurchases(now = new Date()): Promise<number> {
    const result = await this.prisma.membershipPurchase.updateMany({
      where: {
        status: MembershipPurchaseStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: MembershipPurchaseStatus.EXPIRED },
    });
    return result.count;
  }

  async hasUsedMemberDiscount(userId: string): Promise<boolean> {
    const count = await this.prisma.reservation.count({
      where: {
        userId,
        status: {
          in: ['CONFIRMED', 'COMPLETED', 'PAYMENT_PENDING'],
        },
        OR: [
          { coinsEarnable: { gt: 0 } },
          { coinsRedeemed: { gt: 0 } },
          { coinsEarnedAt: { not: null } },
        ],
      },
    });
    return count > 0;
  }

  async getMembershipDashboard(userId: string) {
    const [active, completedBookings, user, periods, lifetimeEarned] =
      await Promise.all([
        this.getActiveMembership(userId),
        this.prisma.reservation.count({
          where: { userId, status: ReservationStatus.COMPLETED },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { alterCashBalance: true },
        }),
        this.prisma.userMembership.findMany({
          where: { userId },
          include: { plan: true },
          orderBy: { activatedAt: 'desc' },
        }),
        this.prisma.alterCashTransaction.aggregate({
          where: { userId, type: 'EARN' },
          _sum: { amount: true },
        }),
      ]);

    const periodRows = await Promise.all(
      periods.map(async (period) => {
        const bookingsCount = await this.prisma.reservation.count({
          where: {
            userId,
            status: { in: ['CONFIRMED', 'COMPLETED'] },
            createdAt: {
              gte: period.activatedAt,
              lt: period.supersededAt ?? period.expiresAt,
            },
          },
        });

        const coinsEarned = await this.prisma.alterCashTransaction.aggregate({
          where: {
            userId,
            type: 'EARN',
            userMembershipId: period.id,
          },
          _sum: { amount: true },
        });

        const fromLabel = period.activatedAt.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
        const toLabel = period.expiresAt.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });

        return {
          id: period.id,
          planName: period.plan.name,
          periodLabel: `${fromLabel} – ${toLabel}`,
          status: period.status,
          bookingsCount,
          coinsEarned: Number(coinsEarned._sum.amount ?? 0),
        };
      }),
    );

    return {
      tier: active?.plan.name ?? 'Free',
      active: active
        ? {
            planCode: active.planCode,
            planName: active.plan.name,
            discountPercent: active.discountPercent,
            activatedAt: active.membership.activatedAt.toISOString(),
            expiresAt: active.membership.expiresAt.toISOString(),
          }
        : null,
      activeMembership: active
        ? {
            planName: active.plan.name,
            expiresAt: active.membership.expiresAt.toISOString(),
            earnPercent: active.discountPercent,
          }
        : null,
      stats: {
        completedBookings,
        coinsBalance: Number(user?.alterCashBalance ?? 0),
        coinsEarnedLifetime: Number(lifetimeEarned._sum.amount ?? 0),
      },
      periods: periodRows,
    };
  }
}
