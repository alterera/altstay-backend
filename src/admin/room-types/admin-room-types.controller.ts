import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from '../dto/admin.dto';
import { AdminPropertiesService } from '../properties/admin-properties.service';
import { AdminRoomTypesService } from './admin-room-types.service';

@Controller('admin/properties/:propertyId/room-types')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminRoomTypesController {
  constructor(
    private readonly roomTypes: AdminRoomTypesService,
    private readonly properties: AdminPropertiesService,
  ) {}

  @Get()
  async list(@Param('propertyId') propertyId: string) {
    await this.properties.getById(propertyId);
    return this.roomTypes.listForProperty(propertyId);
  }

  @Post()
  async create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreateRoomTypeDto,
  ) {
    await this.properties.getById(propertyId);
    return this.roomTypes.create(propertyId, dto);
  }

  @Patch(':roomTypeId')
  async update(
    @Param('propertyId') propertyId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body() dto: UpdateRoomTypeDto,
  ) {
    await this.properties.getById(propertyId);
    return this.roomTypes.update(propertyId, roomTypeId, dto);
  }

  @Delete(':roomTypeId')
  async remove(
    @Param('propertyId') propertyId: string,
    @Param('roomTypeId') roomTypeId: string,
  ) {
    await this.properties.getById(propertyId);
    return this.roomTypes.remove(propertyId, roomTypeId);
  }
}
