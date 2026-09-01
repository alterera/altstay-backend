import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookingsModule } from '../bookings/bookings.module';
import { MembershipModule } from '../membership/membership.module';
import { PrismaModule } from '../prisma/prisma.module';import { BookingPaymentsController } from './booking-payments.controller';
import { ServiceSignatureGuard } from './guards/service-signature.guard';
import { InternalPaymentsController } from './internal-payments.controller';
import { PaymentConfirmationService } from './payment-confirmation.service';
import { PaymentServiceClient } from './payment-service.client';
import { PaymentSessionsService } from './payment-sessions.service';
import { PaymentsConfig } from './payments.config';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    forwardRef(() => BookingsModule),
    forwardRef(() => MembershipModule),
  ],  controllers: [BookingPaymentsController, InternalPaymentsController],
  providers: [
    PaymentsConfig,
    PaymentServiceClient,
    PaymentSessionsService,
    PaymentConfirmationService,
    ServiceSignatureGuard,
  ],
  exports: [PaymentsConfig, PaymentConfirmationService, PaymentServiceClient],})
export class PaymentsModule {}
