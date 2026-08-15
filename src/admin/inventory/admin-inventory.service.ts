import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { eachNight } from '../admin.utils';
import { UpsertInventoryDto } from '../dto/admin.dto';

@Injectable()
export class AdminInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProperty(propertyId: string) {
    return this.prisma.roomInventory.findMany({
      where: { roomType: { propertyId } },
      include: { roomType: true },
      orderBy: [{ date: 'asc' }, { roomTypeId: 'asc' }],
    });
  }

  async upsert(propertyId: string, dto: UpsertInventoryDto) {
    const roomType = await this.prisma.roomType.findFirst({
      where: { id: dto.roomTypeId, propertyId },
    });
    if (!roomType) {
      throw new NotFoundException('Room type not found for this property');
    }

    const nights = eachNight(dto.startDate, dto.endDate);
    const blockedRooms = dto.blockedRooms ?? 0;

    await this.prisma.$transaction(
      nights.map((date) =>
        this.prisma.roomInventory.upsert({
          where: {
            roomTypeId_date: { roomTypeId: dto.roomTypeId, date },
          },
          update: {
            totalRooms: dto.totalRooms,
            blockedRooms,
          },
          create: {
            roomTypeId: dto.roomTypeId,
            date,
            totalRooms: dto.totalRooms,
            blockedRooms,
          },
        }),
      ),
    );

    return this.prisma.roomInventory.findMany({
      where: {
        roomTypeId: dto.roomTypeId,
        date: {
          gte: nights[0],
          lte: nights[nights.length - 1] ?? nights[0],
        },
      },
      orderBy: { date: 'asc' },
    });
  }
}
