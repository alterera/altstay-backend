import { Module } from '@nestjs/common';
import { AlterCashModule } from '../alter-cash/alter-cash.module';
import { BookingsModule } from '../bookings/bookings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminBookingsController } from './bookings/admin-bookings.controller';
import { AdminBookingsService } from './bookings/admin-bookings.service';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminInventoryController } from './inventory/admin-inventory.controller';
import { AdminInventoryService } from './inventory/admin-inventory.service';
import { AdminPropertiesController } from './properties/admin-properties.controller';
import { AdminPropertiesService } from './properties/admin-properties.service';
import { AdminRatePlansController } from './rate-plans/admin-rate-plans.controller';
import { AdminRatePlansService } from './rate-plans/admin-rate-plans.service';
import { AdminRoomTypesController } from './room-types/admin-room-types.controller';
import { AdminRoomTypesService } from './room-types/admin-room-types.service';
import { AdminRoomsController } from './rooms/admin-rooms.controller';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [PrismaModule, UploadsModule, BookingsModule, AlterCashModule],
  controllers: [
    AdminCatalogController,
    AdminBookingsController,
    AdminPropertiesController,
    AdminRoomTypesController,
    AdminRoomsController,
    AdminInventoryController,
    AdminRatePlansController,
  ],
  providers: [
    AdminPropertiesService,
    AdminInventoryService,
    AdminRatePlansService,
    AdminRoomTypesService,
    AdminBookingsService,
  ],
})
export class AdminModule {}
