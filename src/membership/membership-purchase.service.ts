import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  MembershipPurchase,
  MembershipPurchaseStatus,
  Prisma,
} from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSessionResponse,
  PaymentServiceClient,
  PaymentServiceRejectedError,
} from '../payments/payment-service.client';
import { PaymentsConfig } from '../payments/payments.config';
import { MembershipService } from './membership.service';

const DEFAULT_PURCHASE_TTL_MINUTES = 45;

export type MembershipPurchaseSessionResponse = {
  purchaseId: string;
  paymentReference: string;
  checkoutUrl: string;
  paymentSessionId: string;
  cashfreeMode: 'production' | 'sandbox';
  sessionExpiresAt: string | null;
  amount: string;
  currency: string;
  planCode: string;
  planName: string;
};

@Injectable()
export class MembershipPurchaseService {
  private readonly logger = new Logger(MembershipPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly paymentsConfig: PaymentsConfig,
    private readonly paymentClient: PaymentServiceClient,
    private readonly membership: MembershipService,
  ) {}

  get purchaseTtlMs(): number {
    const minutes = Number(
      this.config.get<string>('MEMBERSHIP_PURCHASE_TTL_MINUTES') ??
        DEFAULT_PURCHASE_TTL_MINUTES,
    );
    const safe =
      Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_PURCHASE_TTL_MINUTES;
    return safe * 60 * 1000;
  }

  async createPurchase(
    userId: string,
    planCode: string,
    idempotencyKey: string,
    customer: { name: string; phone?: string; email?: string },
  ): Promise<MembershipPurchaseSessionResponse> {
    const plan = await this.membership.getPlanByCode(planCode);

    const existing = await this.findReusablePurchase(userId, plan.id);
    if (existing) {
      return this.resumePurchase(existing, customer);
    }

    try {
      return await this.createNewPurchase(
        userId,
        plan,
        idempotencyKey,
        customer,
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.prisma.membershipPurchase.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
          include: { plan: true },
        });
        if (replay) {
          if (replay.planId !== plan.id) {
            throw new ConflictException(
              'This Idempotency-Key was already used with a different plan',
            );
          }
          return this.resumePurchase(replay, customer);
        }
      }
      throw error;
    }
  }

  private async findReusablePurchase(
    userId: string,
    planId: string,
  ): Promise<(MembershipPurchase & { plan: { code: string; name: string } }) | null> {
    const cutoff = new Date(Date.now() - this.purchaseTtlMs);
    return this.prisma.membershipPurchase.findFirst({
      where: {
        userId,
        planId,
        status: MembershipPurchaseStatus.PENDING,
        expiresAt: { gt: new Date() },
        createdAt: { gte: cutoff },
      },
      include: { plan: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async createNewPurchase(
    userId: string,
    plan: { id: string; code: string; name: string; price: Prisma.Decimal },
    idempotencyKey: string,
    customer: { name: string; phone?: string; email?: string },
  ): Promise<MembershipPurchaseSessionResponse> {
    const now = new Date();
    const paymentReference = `MEM-${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + this.purchaseTtlMs);

    const purchase = await this.prisma.membershipPurchase.create({
      data: {
        userId,
        planId: plan.id,
        paymentReference,
        amount: plan.price,
        currency: 'INR',
        status: MembershipPurchaseStatus.PENDING,
        idempotencyKey,
        expiresAt,
      },
      include: { plan: true },
    });

    return this.startPaymentSession(purchase, customer);
  }

  private async resumePurchase(
    purchase: MembershipPurchase & { plan: { code: string; name: string } },
    customer: { name: string; phone?: string; email?: string },
  ): Promise<MembershipPurchaseSessionResponse> {
    if (purchase.status !== MembershipPurchaseStatus.PENDING) {
      throw new ConflictException('This purchase is no longer pending payment');
    }
    if (purchase.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(
        'This checkout session expired. Please start again.',
      );
    }
    return this.startPaymentSession(purchase, customer);
  }

  private async startPaymentSession(
    purchase: MembershipPurchase & { plan: { code: string; name: string } },
    customer: { name: string; phone?: string; email?: string },
  ): Promise<MembershipPurchaseSessionResponse> {
    if (!this.paymentsConfig.isPaymentServiceConfigured) {
      throw new BadGatewayException('Payment service is not configured');
    }

    const amount = purchase.amount.toFixed(2);
    let session: CreateSessionResponse;

    try {
      session = await this.paymentClient.createSession({
        paymentReference: purchase.paymentReference,
        reservationReference: purchase.id,
        amount,
        currency: purchase.currency,
        customer,
        returnUrl: this.paymentsConfig.membershipResultUrl(purchase.id),
        expiresAt: purchase.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof PaymentServiceRejectedError) {
        await this.prisma.membershipPurchase.update({
          where: { id: purchase.id },
          data: {
            status: MembershipPurchaseStatus.FAILED,
            failedAt: new Date(),
            failureReason: `PAYMENT_SERVICE_REJECTED: ${error.message}`,
          },
        });
        throw new BadGatewayException(
          'The payment service could not start checkout for this membership',
        );
      }
      throw error;
    }

    await this.prisma.membershipPurchase.update({
      where: { id: purchase.id },
      data: {
        providerOrderId: session.providerOrderId,
      },
    });

    return {
      purchaseId: purchase.id,
      paymentReference: purchase.paymentReference,
      checkoutUrl: session.checkoutUrl,
      paymentSessionId: session.paymentSessionId,
      cashfreeMode: session.cashfreeMode,
      sessionExpiresAt: session.sessionExpiresAt,
      amount,
      currency: purchase.currency,
      planCode: purchase.plan.code,
      planName: purchase.plan.name,
    };
  }

  async getPurchaseForUser(userId: string, purchaseId: string) {
    const purchase = await this.prisma.membershipPurchase.findFirst({
      where: { id: purchaseId, userId },
      include: {
        plan: true,
        membership: true,
      },
    });
    if (!purchase) {
      throw new NotFoundException('Membership purchase not found');
    }
    return purchase;
  }
}
