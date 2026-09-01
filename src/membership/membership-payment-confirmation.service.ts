import { Injectable, Logger } from '@nestjs/common';
import {
  MembershipCancellationReason,
  MembershipPurchaseStatus,
  Prisma,
  UserMembershipStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentNotificationDto } from '../payments/dto/payment-notification.dto';
import { MembershipService } from './membership.service';

export type MembershipNotificationResult = {
  httpStatus: 200 | 409 | 422;
  body: {
    purchaseStatus?: MembershipPurchaseStatus;
    membershipStatus?: UserMembershipStatus;
    duplicate: boolean;
    message?: string;
  };
};

@Injectable()
export class MembershipPaymentConfirmationService {
  private readonly logger = new Logger(MembershipPaymentConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  async handleNotification(
    dto: PaymentNotificationDto,
  ): Promise<MembershipNotificationResult> {
    if (dto.eventType === 'PAYMENT_FAILED') {
      return this.handleFailure(dto);
    }
    return this.handleSuccess(dto);
  }

  private async handleFailure(
    dto: PaymentNotificationDto,
  ): Promise<MembershipNotificationResult> {
    const purchase = await this.prisma.membershipPurchase.findUnique({
      where: { paymentReference: dto.paymentReference },
    });

    if (!purchase) {
      return {
        httpStatus: 422,
        body: {
          duplicate: false,
          message: `Unknown membership purchase ${dto.paymentReference}`,
        },
      };
    }

    if (purchase.status === MembershipPurchaseStatus.CAPTURED) {
      return {
        httpStatus: 200,
        body: {
          purchaseStatus: purchase.status,
          duplicate: true,
        },
      };
    }

    if (purchase.status !== MembershipPurchaseStatus.PENDING) {
      return {
        httpStatus: 200,
        body: {
          purchaseStatus: purchase.status,
          duplicate: true,
        },
      };
    }

    await this.prisma.membershipPurchase.update({
      where: { id: purchase.id },
      data: {
        status: MembershipPurchaseStatus.FAILED,
        failedAt: new Date(dto.occurredAt),
        failureReason: dto.failureReason ?? 'PAYMENT_FAILED',
      },
    });

    return {
      httpStatus: 200,
      body: {
        purchaseStatus: MembershipPurchaseStatus.FAILED,
        duplicate: false,
      },
    };
  }

  private async handleSuccess(
    dto: PaymentNotificationDto,
  ): Promise<MembershipNotificationResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const purchase = await tx.membershipPurchase.findUnique({
        where: { paymentReference: dto.paymentReference },
        include: { plan: true, membership: true },
      });

      if (!purchase) {
        return {
          httpStatus: 422 as const,
          body: {
            duplicate: false,
            message: `Unknown membership purchase ${dto.paymentReference}`,
          },
        };
      }

      if (purchase.status === MembershipPurchaseStatus.CAPTURED) {
        return {
          httpStatus: 200 as const,
          body: {
            purchaseStatus: purchase.status,
            membershipStatus: purchase.membership?.status,
            duplicate: true,
          },
        };
      }

      if (purchase.status !== MembershipPurchaseStatus.PENDING) {
        return {
          httpStatus: 422 as const,
          body: {
            duplicate: false,
            message: `Purchase ${purchase.id} is ${purchase.status}, cannot capture`,
          },
        };
      }

      const expected = purchase.amount.toFixed(2);
      if (dto.amount !== expected) {
        return {
          httpStatus: 422 as const,
          body: {
            duplicate: false,
            message: `Amount mismatch: expected ${expected}, got ${dto.amount}`,
          },
        };
      }

      const paidAt = new Date(dto.occurredAt);
      await tx.membershipPurchase.update({
        where: { id: purchase.id },
        data: {
          status: MembershipPurchaseStatus.CAPTURED,
          paidAt,
          providerOrderId: dto.providerOrderId ?? undefined,
          providerPaymentId: dto.providerPaymentId ?? undefined,
          paymentMethod: dto.paymentMethod ?? undefined,
        },
      });

      const active = await tx.userMembership.findFirst({
        where: {
          userId: purchase.userId,
          status: UserMembershipStatus.ACTIVE,
          expiresAt: { gt: paidAt },
        },
        include: { plan: true },
        orderBy: { activatedAt: 'desc' },
      });

      const expiry = this.membership.computeExpiryForPurchase(
        purchase.userId,
        purchase.plan,
        active
          ? {
              membership: active,
              plan: active.plan,
              planCode: active.plan.code,
              discountPercent: active.plan.discountPercent,
            }
          : null,
        paidAt,
      );

      if (active) {
        await tx.userMembership.update({
          where: { id: active.id },
          data: {
            status: UserMembershipStatus.SUPERSEDED,
            supersededAt: paidAt,
            cancellationReason:
              active.planId === purchase.planId
                ? MembershipCancellationReason.UPGRADE
                : MembershipCancellationReason.UPGRADE,
          },
        });
      }

      const membership = await tx.userMembership.create({
        data: {
          userId: purchase.userId,
          planId: purchase.planId,
          purchaseId: purchase.id,
          status: UserMembershipStatus.ACTIVE,
          activatedAt: paidAt,
          expiresAt: expiry.expiresAt,
          upgradeCreditDays: expiry.upgradeCreditDays,
          upgradeCreditValue: expiry.upgradeCreditValue,
        },
      });

      await this.membership.syncUserProfileFields(tx, purchase.userId);

      this.logger.log(
        `Activated membership ${membership.id} for user ${purchase.userId} via ${dto.paymentReference}`,
      );

      return {
        httpStatus: 200 as const,
        body: {
          purchaseStatus: MembershipPurchaseStatus.CAPTURED,
          membershipStatus: UserMembershipStatus.ACTIVE,
          duplicate: false,
        },
      };
    });

    return outcome;
  }

  async processRefund(
    purchaseId: string,
    reason: string,
  ): Promise<{ refunded: boolean; warning?: string }> {
    const purchase = await this.prisma.membershipPurchase.findUnique({
      where: { id: purchaseId },
      include: { membership: true },
    });

    if (!purchase) {
      throw new Error('Purchase not found');
    }
    if (purchase.status !== MembershipPurchaseStatus.CAPTURED) {
      throw new Error('Only captured purchases can be refunded');
    }

    const usedDiscount = await this.membership.hasUsedMemberDiscount(
      purchase.userId,
    );

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipPurchase.update({
        where: { id: purchase.id },
        data: {
          status: MembershipPurchaseStatus.REFUNDED,
          refundedAt: now,
          refundReason: reason,
        },
      });

      if (purchase.membership) {
        await tx.userMembership.update({
          where: { id: purchase.membership.id },
          data: {
            status: UserMembershipStatus.CANCELLED,
            cancelledAt: now,
            cancellationReason: MembershipCancellationReason.REFUNDED,
          },
        });
      }

      await this.membership.syncUserProfileFields(tx, purchase.userId);
    });

    return {
      refunded: true,
      warning: usedDiscount
        ? 'Member discount was used on at least one booking — manual review recommended'
        : undefined,
    };
  }
}
