import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MembershipPurchaseService } from './membership-purchase.service';
import { MembershipService } from './membership.service';
import {
  CreateMembershipPurchaseDto,
  UpgradePreviewQueryDto,
} from './dto/membership.dto';

type AuthRequest = {
  user: { id: string; phone?: string; email?: string; firstName?: string; lastName?: string };
};

@Controller('memberships')
export class MembershipController {
  constructor(
    private readonly membership: MembershipService,
    private readonly purchases: MembershipPurchaseService,
  ) {}

  @Get('plans')
  async listPlans() {
    const plans = await this.membership.listActivePlans();
    return plans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      price: Number(plan.price),
      durationDays: plan.durationDays,
      discountPercent: plan.discountPercent,
      benefitsDescription: plan.benefitsDescription,
    }));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMyMembership(@Req() req: AuthRequest) {
    return this.membership.getMembershipDashboard(req.user.id);
  }

  @Get('upgrade-preview')
  @UseGuards(JwtAuthGuard)
  upgradePreview(@Req() req: AuthRequest, @Query() query: UpgradePreviewQueryDto) {
    return this.membership.getUpgradePreview(req.user.id, query.planCode);
  }

  @Get('purchases/:id')
  @UseGuards(JwtAuthGuard)
  async getPurchase(@Req() req: AuthRequest, @Param('id') id: string) {
    const purchase = await this.purchases.getPurchaseForUser(req.user.id, id);
    return {
      id: purchase.id,
      status: purchase.status,
      planCode: purchase.plan.code,
      planName: purchase.plan.name,
      amount: Number(purchase.amount),
      currency: purchase.currency,
      paidAt: purchase.paidAt?.toISOString() ?? null,
      membership: purchase.membership
        ? {
            status: purchase.membership.status,
            expiresAt: purchase.membership.expiresAt.toISOString(),
          }
        : null,
    };
  }

  @Post('purchase')
  @UseGuards(JwtAuthGuard)
  async purchase(
    @Req() req: AuthRequest,
    @Body() dto: CreateMembershipPurchaseDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const name =
      [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') ||
      'AlterStay Member';

    return this.purchases.createPurchase(
      req.user.id,
      dto.planCode,
      idempotencyKey.trim(),
      {
        name,
        phone: req.user.phone,
        email: req.user.email,
      },
    );
  }
}
