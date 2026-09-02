import { BadRequestException } from '@nestjs/common';
import { AdminInventoryService } from './admin-inventory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminRoomTypesService } from '../room-types/admin-room-types.service';

describe('AdminInventoryService', () => {
  let service: AdminInventoryService;
  let prisma: {
    roomInventory: {
      findMany: jest.Mock;
      upsert: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let roomTypes: { assertRoomType: jest.Mock };

  beforeEach(() => {
    prisma = {
      roomInventory: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    roomTypes = { assertRoomType: jest.fn().mockResolvedValue({ id: 'rt-1' }) };
    service = new AdminInventoryService(
      prisma as unknown as PrismaService,
      roomTypes as unknown as AdminRoomTypesService,
    );
  });

  describe('upsert', () => {
    it('rejects when totalRooms is below sold + blocked', async () => {
      prisma.roomInventory.findMany.mockResolvedValue([
        {
          date: new Date('2026-09-01'),
          soldRooms: 3,
        },
      ]);

      await expect(
        service.upsert('p-1', {
          roomTypeId: 'rt-1',
          startDate: '2026-09-01',
          endDate: '2026-09-02',
          totalRooms: 2,
          blockedRooms: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
