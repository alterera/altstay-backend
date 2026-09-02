import { BadRequestException } from '@nestjs/common';
import { AdminRoomTypesService } from './admin-room-types.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('AdminRoomTypesService', () => {
  let service: AdminRoomTypesService;
  let prisma: {
    roomType: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    reservationItem: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      roomType: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      reservationItem: { count: jest.fn() },
    };
    service = new AdminRoomTypesService(prisma as unknown as PrismaService);
  });

  describe('remove', () => {
    it('blocks delete when bookings exist', async () => {
      prisma.roomType.findFirst.mockResolvedValue({ id: 'rt-1', propertyId: 'p-1' });
      prisma.reservationItem.count.mockResolvedValue(2);

      await expect(service.remove('p-1', 'rt-1')).rejects.toMatchObject({
        message: expect.stringContaining('booking history'),
      });
      expect(prisma.roomType.delete).not.toHaveBeenCalled();
    });

    it('deletes when no bookings exist', async () => {
      prisma.roomType.findFirst.mockResolvedValue({ id: 'rt-1', propertyId: 'p-1' });
      prisma.reservationItem.count.mockResolvedValue(0);

      await service.remove('p-1', 'rt-1');
      expect(prisma.roomType.delete).toHaveBeenCalledWith({ where: { id: 'rt-1' } });
    });
  });

  describe('update', () => {
    it('rejects invalid status', async () => {
      prisma.roomType.findFirst.mockResolvedValue({ id: 'rt-1' });

      await expect(
        service.update('p-1', 'rt-1', { status: 'ARCHIVED' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
