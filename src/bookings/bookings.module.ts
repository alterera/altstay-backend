import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadsModule } from '../admin/uploads/uploads.module';
import { PricingModule } from '../pricing/pricing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingIdempotencyService } from './booking-idempotency.service';
import { BookingInventoryService } from './booking-inventory.service';
import { BookingMaintenanceService } from './booking-maintenance.service';
import { BookingNumberService } from './booking-number.service';
import { BookingValidationService } from './booking-validation.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({
  imports: [PrismaModule, PricingModule, AuthModule, UploadsModule],
  controllers: [BookingsController, QuotesController],
  providers: [
    BookingsService,
    QuotesService,
    BookingValidationService,
    BookingInventoryService,
    BookingNumberService,
    BookingIdempotencyService,
    BookingMaintenanceService,
  ],
  exports: [BookingsService, BookingInventoryService],
})
export class BookingsModule {}
