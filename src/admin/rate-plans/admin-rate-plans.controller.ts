import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CreateRatePlanDto,
  UpsertRatePricesDto,
} from '../dto/admin.dto';
import { AdminRatePlansService } from './admin-rate-plans.service';
import { AdminPropertiesService } from '../properties/admin-properties.service';

@Controller('admin/properties/:propertyId/rate-plans')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminRatePlansController {
  constructor(
    private readonly ratePlans: AdminRatePlansService,
    private readonly properties: AdminPropertiesService,
  ) {}

  @Get()
  async list(@Param('propertyId') propertyId: string) {
    await this.properties.getById(propertyId);
    return this.ratePlans.listForProperty(propertyId);
  }

  @Post()
  async create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreateRatePlanDto,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.create(propertyId, dto);
  }

  @Post('prices')
  async upsertPrices(@Body() dto: UpsertRatePricesDto) {
    return this.ratePlans.upsertPrices(dto);
  }
}
