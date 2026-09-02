import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  UpdateInventoryRowDto,
  UpsertInventoryDto,
} from '../dto/admin.dto';
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
  async list(
    @Param('propertyId') propertyId: string,
    @Query('roomTypeId') roomTypeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.properties.getById(propertyId);
    return this.inventory.listForProperty(propertyId, {
      roomTypeId,
      from,
      to,
    });
  }

  @Post()
  async upsert(
    @Param('propertyId') propertyId: string,
    @Body() dto: UpsertInventoryDto,
  ) {
    await this.properties.getById(propertyId);
    return this.inventory.upsert(propertyId, dto);
  }

  @Patch(':inventoryId')
  async updateRow(
    @Param('propertyId') propertyId: string,
    @Param('inventoryId') inventoryId: string,
    @Body() dto: UpdateInventoryRowDto,
  ) {
    await this.properties.getById(propertyId);
    return this.inventory.updateRow(propertyId, inventoryId, dto);
  }

  @Delete()
  async deleteRange(
    @Param('propertyId') propertyId: string,
    @Query('roomTypeId') roomTypeId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.properties.getById(propertyId);
    return this.inventory.deleteRange(propertyId, roomTypeId, from, to);
  }
}
