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
  CreateRatePlanDto,
  UpdateRatePlanDto,
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

  @Get(':ratePlanId')
  async getOne(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.getById(propertyId, ratePlanId);
  }

  @Post()
  async create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreateRatePlanDto,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.create(propertyId, dto);
  }

  @Patch(':ratePlanId')
  async update(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body() dto: UpdateRatePlanDto,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.update(propertyId, ratePlanId, dto);
  }

  @Delete(':ratePlanId')
  async remove(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.remove(propertyId, ratePlanId);
  }

  @Get(':ratePlanId/prices')
  async listPrices(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.listPrices(propertyId, ratePlanId, from, to);
  }

  @Post(':ratePlanId/prices')
  async upsertPrices(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body() dto: UpsertRatePricesDto,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.upsertPrices(propertyId, ratePlanId, dto);
  }

  @Delete(':ratePlanId/prices')
  async deletePrices(
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.properties.getById(propertyId);
    return this.ratePlans.deletePrices(propertyId, ratePlanId, from, to);
  }
}
