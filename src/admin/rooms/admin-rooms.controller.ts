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
import { CreateRoomDto } from '../dto/admin.dto';
import { AdminPropertiesService } from '../properties/admin-properties.service';

@Controller('admin/properties/:propertyId/rooms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminRoomsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly properties: AdminPropertiesService,
  ) {}

  @Get()
  async list(@Param('propertyId') propertyId: string) {
    await this.properties.getById(propertyId);
    return this.prisma.room.findMany({
      where: { propertyId },
      include: { roomType: true },
      orderBy: { roomNumber: 'asc' },
    });
  }

  @Post()
  async create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreateRoomDto,
  ) {
    await this.properties.getById(propertyId);
    const roomType = await this.prisma.roomType.findFirst({
      where: { id: dto.roomTypeId, propertyId },
    });
    if (!roomType) throw new NotFoundException('Room type not found');

    return this.prisma.room.create({
      data: {
        propertyId,
        roomTypeId: dto.roomTypeId,
        roomNumber: dto.roomNumber,
        floor: dto.floor,
        status: dto.status ?? 'ACTIVE',
      },
    });
  }

  @Patch(':roomId')
  async update(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
    @Body() dto: Partial<CreateRoomDto>,
  ) {
    await this.assertRoom(propertyId, roomId);
    return this.prisma.room.update({
      where: { id: roomId },
      data: {
        roomNumber: dto.roomNumber,
        floor: dto.floor,
        status: dto.status,
        roomTypeId: dto.roomTypeId,
      },
    });
  }

  @Delete(':roomId')
  async remove(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
  ) {
    await this.assertRoom(propertyId, roomId);
    await this.prisma.room.delete({ where: { id: roomId } });
    return { success: true };
  }

  private async assertRoom(propertyId: string, roomId: string) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, propertyId },
    });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }
}
