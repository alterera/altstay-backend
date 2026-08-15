import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UpsertInventoryDto } from '../dto/admin.dto';
import { AdminInventoryService } from './admin-inventory.service';
import { AdminPropertiesService } from '../properties/admin-properties.service';

@Controller('admin/properties/:propertyId/inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminInventoryController {
  constructor(
    private readonly inventory: AdminInventoryService,
    private readonly properties: AdminPropertiesService,
  ) {}

  @Get()
  async list(@Param('propertyId') propertyId: string) {
    await this.properties.getById(propertyId);
    return this.inventory.listForProperty(propertyId);
  }

  @Post()
  async upsert(
    @Param('propertyId') propertyId: string,
    @Body() dto: UpsertInventoryDto,
  ) {
    await this.properties.getById(propertyId);
    return this.inventory.upsert(propertyId, dto);
  }
}
