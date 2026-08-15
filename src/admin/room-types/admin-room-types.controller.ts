import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from '../dto/admin.dto';
import { AdminPropertiesService } from '../properties/admin-properties.service';

@Controller('admin/properties/:propertyId/room-types')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminRoomTypesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly properties: AdminPropertiesService,
  ) {}

  @Get()
  async list(@Param('propertyId') propertyId: string) {
    await this.properties.getById(propertyId);
    return this.prisma.roomType.findMany({
      where: { propertyId },
      include: {
        _count: { select: { rooms: true, ratePlans: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  async create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreateRoomTypeDto,
  ) {
    await this.properties.getById(propertyId);
    return this.prisma.roomType.create({
      data: {
        propertyId,
        name: dto.name,
        description: dto.description,
        maxAdults: dto.maxAdults,
        maxChildren: dto.maxChildren ?? 0,
        maxOccupancy: dto.maxOccupancy,
        bedType: dto.bedType,
        sizeSqm: dto.sizeSqm,
      },
    });
  }

  @Patch(':roomTypeId')
  async update(
    @Param('propertyId') propertyId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body() dto: UpdateRoomTypeDto,
  ) {
    await this.assertRoomType(propertyId, roomTypeId);
    return this.prisma.roomType.update({
      where: { id: roomTypeId },
      data: dto,
    });
  }

  @Delete(':roomTypeId')
  async remove(
    @Param('propertyId') propertyId: string,
    @Param('roomTypeId') roomTypeId: string,
  ) {
    await this.assertRoomType(propertyId, roomTypeId);
    await this.prisma.roomType.delete({ where: { id: roomTypeId } });
    return { success: true };
  }

  private async assertRoomType(propertyId: string, roomTypeId: string) {
    const roomType = await this.prisma.roomType.findFirst({
      where: { id: roomTypeId, propertyId },
    });
    if (!roomType) throw new NotFoundException('Room type not found');
    return roomType;
  }
}
