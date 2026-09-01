import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminMembershipsController } from './admin-memberships.controller';
import { AdminMembershipsService } from './admin-memberships.service';
import { MembershipController } from './membership.controller';
import { MembershipCronService } from './membership-cron.service';
import { MembershipPaymentConfirmationService } from './membership-payment-confirmation.service';
import { MembershipPurchaseService } from './membership-purchase.service';
import { MembershipService } from './membership.service';

@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => PaymentsModule)],
  controllers: [MembershipController, AdminMembershipsController],
  providers: [
    MembershipService,
    MembershipPurchaseService,
    MembershipPaymentConfirmationService,
    MembershipCronService,
    AdminMembershipsService,
  ],
  exports: [MembershipService, MembershipPaymentConfirmationService],
})
export class MembershipModule {}
