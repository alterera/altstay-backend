import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PricingModule } from '../pricing/pricing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingIdempotencyService } from './booking-idempotency.service';
import { BookingInventoryService } from './booking-inventory.service';
import { BookingMaintenanceService } from './booking-maintenance.service';
import { BookingNumberService } from './booking-number.service';
import { BookingValidationService } from './booking-validation.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  imports: [PrismaModule, PricingModule, AuthModule],
  controllers: [BookingsController],
  providers: [
    BookingsService,
    BookingValidationService,
    BookingInventoryService,
    BookingNumberService,
    BookingIdempotencyService,
    BookingMaintenanceService,
  ],
  exports: [BookingsService, BookingInventoryService],
})
export class BookingsModule {}
