import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertDateRange,
  defaultInventoryRange,
  parseIsoDate,
} from '../admin.utils';
import { UpdateInventoryRowDto, UpsertInventoryDto } from '../dto/admin.dto';
import { AdminRoomTypesService } from '../room-types/admin-room-types.service';

@Injectable()
export class AdminInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roomTypes: AdminRoomTypesService,
  ) {}

  async listForProperty(
    propertyId: string,
    filters: { roomTypeId?: string; from?: string; to?: string } = {},
  ) {
    const range = defaultInventoryRange();
    const from = filters.from ?? range.from;
    const to = filters.to ?? range.to;

    return this.prisma.roomInventory.findMany({
      where: {
        roomType: { propertyId },
        ...(filters.roomTypeId ? { roomTypeId: filters.roomTypeId } : {}),
        date: {
          gte: parseIsoDate(from),
          lt: parseIsoDate(to),
        },
      },
      include: { roomType: true },
      orderBy: [{ date: 'asc' }, { roomTypeId: 'asc' }],
    });
  }

  async upsert(propertyId: string, dto: UpsertInventoryDto) {
    await this.roomTypes.assertRoomType(propertyId, dto.roomTypeId);
    const nights = assertDateRange(dto.startDate, dto.endDate);
    const blockedRooms = dto.blockedRooms ?? 0;

    if (dto.totalRooms < blockedRooms) {
      throw new BadRequestException(
        'totalRooms must be greater than or equal to blockedRooms',
      );
    }

    const existing = await this.prisma.roomInventory.findMany({
      where: {
        roomTypeId: dto.roomTypeId,
        date: { in: nights },
      },
    });
    for (const row of existing) {
      if (dto.totalRooms < row.soldRooms + blockedRooms) {
        throw new BadRequestException(
          `Cannot set totalRooms below sold (${row.soldRooms}) + blocked (${blockedRooms}) for ${row.date.toISOString().slice(0, 10)}`,
        );
      }
    }

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

    return this.listForProperty(propertyId, {
      roomTypeId: dto.roomTypeId,
      from: dto.startDate,
      to: dto.endDate,
    });
  }

  async updateRow(
    propertyId: string,
    inventoryId: string,
    dto: UpdateInventoryRowDto,
  ) {
    const row = await this.prisma.roomInventory.findFirst({
      where: { id: inventoryId, roomType: { propertyId } },
    });
    if (!row) throw new NotFoundException('Inventory row not found');

    if (dto.totalRooms < dto.blockedRooms + row.soldRooms) {
      throw new BadRequestException(
        `totalRooms must be at least ${row.soldRooms + dto.blockedRooms} (sold + blocked)`,
      );
    }

    return this.prisma.roomInventory.update({
      where: { id: inventoryId },
      data: {
        totalRooms: dto.totalRooms,
        blockedRooms: dto.blockedRooms,
      },
      include: { roomType: true },
    });
  }

  async deleteRange(
    propertyId: string,
    roomTypeId: string,
    startDate: string,
    endDate: string,
  ) {
    await this.roomTypes.assertRoomType(propertyId, roomTypeId);
    const nights = assertDateRange(startDate, endDate);

    const rows = await this.prisma.roomInventory.findMany({
      where: {
        roomTypeId,
        date: { in: nights },
      },
    });

    const withSold = rows.filter((row) => row.soldRooms > 0);
    if (withSold.length > 0) {
      throw new ConflictException(
        'Cannot delete inventory rows with sold rooms. Adjust totals instead.',
      );
    }

    await this.prisma.roomInventory.deleteMany({
      where: {
        roomTypeId,
        date: { in: nights },
      },
    });

    return { deleted: rows.length };
  }
}
