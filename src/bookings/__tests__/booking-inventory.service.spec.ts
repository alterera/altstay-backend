import { ConflictException } from '@nestjs/common';
import {
  BookingInventoryService,
  computeFreeRooms,
} from '../booking-inventory.service';
import { PricingClient } from '../../pricing/pricing.types';

const utc = (day: string) => new Date(`2026-09-${day}T00:00:00.000Z`);

type LockRow = {
  dateText: string;
  totalRooms: number;
  blockedRooms: number;
  soldRooms: number;
};

function row(
  day: string,
  totalRooms: number,
  blockedRooms = 0,
  soldRooms = 0,
): LockRow {
  return { dateText: `2026-09-${day}`, totalRooms, blockedRooms, soldRooms };
}

/** Returns the individual mocks alongside the client so assertions stay typed. */
function mockTx(
  lockRows: LockRow[],
  holdGroups: { date: Date; _sum: { quantity: number | null } }[] = [],
) {
  const queryRaw = jest.fn().mockResolvedValue(lockRows);
  const groupBy = jest.fn().mockResolvedValue(holdGroups);
  const deleteMany = jest.fn().mockResolvedValue({ count: 3 });

  const tx = {
    $queryRaw: queryRaw,
    inventoryHold: { groupBy, deleteMany },
  } as unknown as PricingClient;

  return { tx, queryRaw, groupBy, deleteMany };
}

describe('computeFreeRooms', () => {
  it('subtracts blocked, sold and held rooms from the total', () => {
    expect(
      computeFreeRooms({
        totalRooms: 10,
        blockedRooms: 1,
        soldRooms: 2,
        heldRooms: 3,
      }),
    ).toBe(4);
  });

  it('can go negative when inventory was oversold administratively', () => {
    expect(
      computeFreeRooms({
        totalRooms: 2,
        blockedRooms: 0,
        soldRooms: 3,
        heldRooms: 0,
      }),
    ).toBe(-1);
  });

  it('treats an unheld night as fully available', () => {
    expect(
      computeFreeRooms({
        totalRooms: 5,
        blockedRooms: 0,
        soldRooms: 0,
        heldRooms: 0,
      }),
    ).toBe(5);
  });
});

describe('BookingInventoryService', () => {
  let inventory: BookingInventoryService;
  const nights = [utc('10'), utc('11')];

  beforeEach(() => {
    inventory = new BookingInventoryService();
  });

  describe('lockAndAssertAvailable', () => {
    it('returns per-night availability with holds subtracted', async () => {
      const { tx } = mockTx(
        [row('10', 5), row('11', 5, 1)],
        [{ date: utc('10'), _sum: { quantity: 2 } }],
      );

      const availability = await inventory.lockAndAssertAvailable(
        tx,
        'room-1',
        nights,
        1,
      );

      expect(availability).toEqual([
        {
          date: '2026-09-10',
          totalRooms: 5,
          blockedRooms: 0,
          soldRooms: 0,
          heldRooms: 2,
          freeRooms: 3,
        },
        {
          date: '2026-09-11',
          totalRooms: 5,
          blockedRooms: 1,
          soldRooms: 0,
          heldRooms: 0,
          freeRooms: 4,
        },
      ]);
    });

    it('locks the inventory rows FOR UPDATE in date order', async () => {
      const { tx, queryRaw } = mockTx([row('10', 2), row('11', 2)]);

      await inventory.lockAndAssertAvailable(tx, 'room-1', nights, 1);

      // $queryRaw is a tagged template, so the first argument is the strings array.
      const [templateStrings] = queryRaw.mock.calls[0] as [string[]];
      const sql = templateStrings.join(' ? ');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('ORDER BY "date" ASC');
    });

    it('rejects the booking when a night is fully held', async () => {
      const { tx } = mockTx(
        [row('10', 2), row('11', 2)],
        [{ date: utc('11'), _sum: { quantity: 2 } }],
      );

      await expect(
        inventory.lockAndAssertAvailable(tx, 'room-1', nights, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects when the request wants more rooms than remain', async () => {
      const { tx } = mockTx(
        [row('10', 2), row('11', 2)],
        [{ date: utc('10'), _sum: { quantity: 1 } }],
      );

      await expect(
        inventory.lockAndAssertAvailable(tx, 'room-1', nights, 2),
      ).rejects.toThrow(/1 room\(s\) left for 2026-09-10/);
    });

    it('allows a request that takes exactly the remaining rooms', async () => {
      const { tx } = mockTx([row('10', 2), row('11', 2)]);

      await expect(
        inventory.lockAndAssertAvailable(tx, 'room-1', nights, 2),
      ).resolves.toHaveLength(2);
    });

    it('rejects when a night has no inventory row at all', async () => {
      const { tx } = mockTx([row('10', 5)]);

      await expect(
        inventory.lockAndAssertAvailable(tx, 'room-1', nights, 1),
      ).rejects.toThrow(/No inventory is loaded for 2026-09-11/);
    });
  });

  describe('activeHoldQuantities', () => {
    it('only counts unexpired holds on reservations that still hold', async () => {
      const now = new Date('2026-09-01T10:00:00.000Z');
      const { tx, groupBy } = mockTx(
        [],
        [{ date: utc('10'), _sum: { quantity: 4 } }],
      );

      const held = await inventory.activeHoldQuantities(
        tx,
        'room-1',
        nights,
        now,
      );

      expect(held.get('2026-09-10')).toBe(4);
      const [args] = groupBy.mock.calls[0] as [
        { where: { expiresAt: unknown; reservation: unknown } },
      ];
      expect(args.where.expiresAt).toEqual({ gt: now });
      expect(args.where.reservation).toEqual({
        status: { in: ['PAYMENT_PENDING'] },
      });
    });

    it('treats a null sum as zero held rooms', async () => {
      const { tx } = mockTx(
        [],
        [{ date: utc('10'), _sum: { quantity: null } }],
      );

      const held = await inventory.activeHoldQuantities(tx, 'room-1', nights);

      expect(held.get('2026-09-10')).toBe(0);
    });
  });

  describe('buildHoldRows', () => {
    it('creates one hold row per night carrying the room count', () => {
      const expiresAt = new Date('2026-09-01T10:10:00.000Z');

      const rows = inventory.buildHoldRows(
        'res-1',
        'room-1',
        nights,
        3,
        expiresAt,
      );

      expect(rows).toEqual([
        {
          reservationId: 'res-1',
          roomTypeId: 'room-1',
          date: utc('10'),
          quantity: 3,
          expiresAt,
        },
        {
          reservationId: 'res-1',
          roomTypeId: 'room-1',
          date: utc('11'),
          quantity: 3,
          expiresAt,
        },
      ]);
    });
  });

  describe('releaseHolds', () => {
    it('deletes every hold belonging to the reservation', async () => {
      const { tx, deleteMany } = mockTx([]);

      await expect(inventory.releaseHolds(tx, 'res-1')).resolves.toBe(3);
      expect(deleteMany).toHaveBeenCalledWith({
        where: { reservationId: 'res-1' },
      });
    });
  });

  describe('convertHoldsToSold', () => {
    it('locks inventory, increments soldRooms, then deletes the holds', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);
      const executeRaw = jest.fn().mockResolvedValue(2);
      const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
      const tx = {
        $queryRaw: queryRaw,
        $executeRaw: executeRaw,
        inventoryHold: { deleteMany },
      } as unknown as PricingClient;

      await expect(inventory.convertHoldsToSold(tx, 'res-1')).resolves.toBe(2);
      expect(queryRaw).toHaveBeenCalled();
      expect(executeRaw).toHaveBeenCalled();
      expect(deleteMany).toHaveBeenCalledWith({
        where: { reservationId: 'res-1' },
      });
    });
  });

  describe('sellRooms', () => {
    it('increments soldRooms for the given nights', async () => {
      const executeRaw = jest.fn().mockResolvedValue(2);
      const tx = { $executeRaw: executeRaw } as unknown as PricingClient;

      await expect(inventory.sellRooms(tx, 'room-1', nights, 1)).resolves.toBe(
        2,
      );
      expect(executeRaw).toHaveBeenCalled();
    });
  });
});
