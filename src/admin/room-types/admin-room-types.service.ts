import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from '../dto/admin.dto';

const ROOM_TYPE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

@Injectable()
export class AdminRoomTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProperty(propertyId: string) {
    return this.prisma.roomType.findMany({
      where: { propertyId },
      include: {
        _count: { select: { ratePlans: true, reservationItems: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(propertyId: string, dto: CreateRoomTypeDto) {
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

  async update(
    propertyId: string,
    roomTypeId: string,
    dto: UpdateRoomTypeDto,
  ) {
    await this.assertRoomType(propertyId, roomTypeId);
    if (dto.status !== undefined && !ROOM_TYPE_STATUSES.includes(dto.status as typeof ROOM_TYPE_STATUSES[number])) {
      throw new BadRequestException(
        `status must be one of: ${ROOM_TYPE_STATUSES.join(', ')}`,
      );
    }
    return this.prisma.roomType.update({
      where: { id: roomTypeId },
      data: dto,
    });
  }

  async remove(propertyId: string, roomTypeId: string) {
    await this.assertRoomType(propertyId, roomTypeId);

    const bookingCount = await this.prisma.reservationItem.count({
      where: { roomTypeId },
    });
    if (bookingCount > 0) {
      throw new ConflictException(
        'Cannot delete: this room type has booking history. Set status to INACTIVE instead.',
      );
    }

    await this.prisma.roomType.delete({ where: { id: roomTypeId } });
    return { success: true };
  }

  async assertRoomType(propertyId: string, roomTypeId: string) {
    const roomType = await this.prisma.roomType.findFirst({
      where: { id: roomTypeId, propertyId },
    });
    if (!roomType) throw new NotFoundException('Room type not found');
    return roomType;
  }
}
