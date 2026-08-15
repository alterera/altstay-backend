import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminInventoryController } from './inventory/admin-inventory.controller';
import { AdminInventoryService } from './inventory/admin-inventory.service';
import { AdminPropertiesController } from './properties/admin-properties.controller';
import { AdminPropertiesService } from './properties/admin-properties.service';
import { AdminRatePlansController } from './rate-plans/admin-rate-plans.controller';
import { AdminRatePlansService } from './rate-plans/admin-rate-plans.service';
import { AdminRoomTypesController } from './room-types/admin-room-types.controller';
import { AdminRoomsController } from './rooms/admin-rooms.controller';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [PrismaModule, UploadsModule],
  controllers: [
    AdminCatalogController,
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
  ],
})
export class AdminModule {}
