import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MembershipCancellationReason,
  MembershipPurchaseStatus,
  UserMembershipStatus,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipPaymentConfirmationService } from './membership-payment-confirmation.service';
import { MembershipService } from './membership.service';
import { AdminUpdateMembershipDto } from './dto/membership.dto';
import { addDays } from './membership.utils';

@Injectable()
export class AdminMembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    private readonly confirmation: MembershipPaymentConfirmationService,
  ) {}

  async list(params: {
    status?: string;
    userId?: string;
    page: number;
    limit: number;
  }) {
    const where = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.status
        ? { status: params.status as UserMembershipStatus }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.userMembership.findMany({
        where,
        include: {
          plan: true,
          user: { select: { id: true, phone: true, firstName: true, lastName: true } },
          purchase: { select: { id: true, paymentReference: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.userMembership.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        userPhone: item.user.phone,
        userName: [item.user.firstName, item.user.lastName].filter(Boolean).join(' '),
        planCode: item.plan.code,
        planName: item.plan.name,
        status: item.status,
        activatedAt: item.activatedAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        purchaseId: item.purchaseId,
        purchaseStatus: item.purchase.status,
      })),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  async updateMembership(id: string, dto: AdminUpdateMembershipDto) {
    const membership = await this.prisma.userMembership.findUnique({
      where: { id },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    if (dto.action === 'cancel') {
      await this.prisma.$transaction(async (tx) => {
        await tx.userMembership.update({
          where: { id },
          data: {
            status: UserMembershipStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: MembershipCancellationReason.ADMIN,
          },
        });
        await this.membership.syncUserProfileFields(tx, membership.userId);
      });
      return { status: UserMembershipStatus.CANCELLED };
    }

    if (dto.action === 'extend') {
      if (!dto.extendDays || dto.extendDays < 1) {
        throw new BadRequestException('extendDays must be a positive integer');
      }
      const expiresAt = addDays(membership.expiresAt, dto.extendDays);
      await this.prisma.$transaction(async (tx) => {
        await tx.userMembership.update({
          where: { id },
          data: { expiresAt },
        });
        await this.membership.syncUserProfileFields(tx, membership.userId);
      });
      return { expiresAt: expiresAt.toISOString() };
    }

    throw new BadRequestException('Unsupported action');
  }

  async refundPurchase(purchaseId: string, reason: string) {
    const purchase = await this.prisma.membershipPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) {
      throw new NotFoundException('Purchase not found');
    }
    if (purchase.status !== MembershipPurchaseStatus.CAPTURED) {
      throw new BadRequestException('Only captured purchases can be refunded');
    }

    const result = await this.confirmation.processRefund(purchaseId, reason);
    return result;
  }
}
