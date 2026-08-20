import { ConflictException, HttpException } from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BookingIdempotencyService,
  IDEMPOTENCY_STALE_MS,
  IDEMPOTENCY_TTL_MS,
} from '../booking-idempotency.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['userId', 'idempotencyKey'] },
  });
}

describe('BookingIdempotencyService', () => {
  let prisma: {
    bookingIdempotency: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let idempotency: BookingIdempotencyService;

  beforeEach(() => {
    prisma = {
      bookingIdempotency: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    idempotency = new BookingIdempotencyService(
      prisma as unknown as PrismaService,
    );
  });

  describe('hashRequest', () => {
    it('ignores key order', () => {
      const a = idempotency.hashRequest({ rooms: 2, propertySlug: 'alpha' });
      const b = idempotency.hashRequest({ propertySlug: 'alpha', rooms: 2 });

      expect(a).toBe(b);
    });

    it('ignores key order in nested objects', () => {
      const a = idempotency.hashRequest({
        guest: { firstName: 'Asha', lastName: 'R' },
      });
      const b = idempotency.hashRequest({
        guest: { lastName: 'R', firstName: 'Asha' },
      });

      expect(a).toBe(b);
    });

    it('changes when a value changes', () => {
      const a = idempotency.hashRequest({ rooms: 1 });
      const b = idempotency.hashRequest({ rooms: 2 });

      expect(a).not.toBe(b);
    });

    it('preserves array order, which is meaningful', () => {
      const a = idempotency.hashRequest({ nights: ['a', 'b'] });
      const b = idempotency.hashRequest({ nights: ['b', 'a'] });

      expect(a).not.toBe(b);
    });

    it('treats an absent field and an undefined field alike', () => {
      const a = idempotency.hashRequest({ rooms: 1 });
      const b = idempotency.hashRequest({ rooms: 1, lastName: undefined });

      expect(a).toBe(b);
    });
  });

  describe('claim', () => {
    const now = new Date('2026-08-19T10:00:00.000Z');

    it('acquires the claim when the insert wins', async () => {
      prisma.bookingIdempotency.create.mockResolvedValue({ id: 'claim-1' });

      const result = await idempotency.claim('user-1', 'key-1', 'hash-1', now);

      expect(result).toEqual({ outcome: 'ACQUIRED', claimId: 'claim-1' });
    });

    it('writes the claim as IN_PROGRESS with a 24h expiry', async () => {
      prisma.bookingIdempotency.create.mockResolvedValue({ id: 'claim-1' });

      await idempotency.claim('user-1', 'key-1', 'hash-1', now);

      expect(prisma.bookingIdempotency.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: 'user-1',
            idempotencyKey: 'key-1',
            requestHash: 'hash-1',
            status: IdempotencyStatus.IN_PROGRESS,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        }),
      );
    });

    // The lost-response retry: the booking committed, the client never saw it.
    it('replays the original reservation for a completed claim', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue({
        requestHash: 'hash-1',
        status: IdempotencyStatus.COMPLETED,
        reservationId: 'res-1',
      });

      const result = await idempotency.claim('user-1', 'key-1', 'hash-1', now);

      expect(result).toEqual({ outcome: 'REPLAY', reservationId: 'res-1' });
    });

    it('rejects the same key used with a different body', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue({
        requestHash: 'a-different-hash',
        status: IdempotencyStatus.COMPLETED,
        reservationId: 'res-1',
      });

      await expect(
        idempotency.claim('user-1', 'key-1', 'hash-1', now),
      ).rejects.toThrow(ConflictException);
    });

    it('checks the body hash before replaying', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue({
        requestHash: 'a-different-hash',
        status: IdempotencyStatus.COMPLETED,
        reservationId: 'res-1',
      });

      await expect(
        idempotency.claim('user-1', 'key-1', 'hash-1', now),
      ).rejects.toThrow(/different booking request/);
    });

    // The concurrent case: a sibling request holds the claim and has not finished.
    it('asks the caller to retry while a sibling request is in flight', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue({
        requestHash: 'hash-1',
        status: IdempotencyStatus.IN_PROGRESS,
        reservationId: null,
      });

      const thrown = await idempotency
        .claim('user-1', 'key-1', 'hash-1', now)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(HttpException);
      const error = thrown as HttpException;
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ retryAfterSec: 2 });
    });

    it('asks the caller to retry when a completed claim lost its reservation id', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue({
        requestHash: 'hash-1',
        status: IdempotencyStatus.COMPLETED,
        reservationId: null,
      });

      await expect(
        idempotency.claim('user-1', 'key-1', 'hash-1', now),
      ).rejects.toThrow(HttpException);
    });

    it('asks the caller to retry when cleanup removed the row mid-flight', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(uniqueViolation());
      prisma.bookingIdempotency.findUnique.mockResolvedValue(null);

      await expect(
        idempotency.claim('user-1', 'key-1', 'hash-1', now),
      ).rejects.toThrow(/Please retry/);
    });

    it('propagates errors that are not unique violations', async () => {
      prisma.bookingIdempotency.create.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        idempotency.claim('user-1', 'key-1', 'hash-1', now),
      ).rejects.toThrow('connection reset');
      expect(prisma.bookingIdempotency.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('markCompleted', () => {
    it('records the reservation on the claim', async () => {
      const tx = {
        bookingIdempotency: { update: jest.fn().mockResolvedValue({}) },
      };

      await idempotency.markCompleted(tx as never, 'claim-1', 'res-1');

      expect(tx.bookingIdempotency.update).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: {
          status: IdempotencyStatus.COMPLETED,
          reservationId: 'res-1',
        },
      });
    });
  });

  describe('release', () => {
    it('deletes the claim so the key can be retried', async () => {
      await idempotency.release('claim-1');

      expect(prisma.bookingIdempotency.delete).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
      });
    });

    it('swallows a delete failure rather than masking the original error', async () => {
      prisma.bookingIdempotency.delete.mockRejectedValue(new Error('gone'));

      await expect(idempotency.release('claim-1')).resolves.toBeUndefined();
    });
  });

  describe('cleanup', () => {
    const now = new Date('2026-08-19T10:00:00.000Z');

    it('deletes expired completed claims and stale in-progress ones', async () => {
      prisma.bookingIdempotency.deleteMany
        .mockResolvedValueOnce({ count: 4 })
        .mockResolvedValueOnce({ count: 1 });

      const result = await idempotency.cleanup(now);

      expect(result).toEqual({ expired: 4, stale: 1 });
      expect(prisma.bookingIdempotency.deleteMany).toHaveBeenNthCalledWith(1, {
        where: {
          status: IdempotencyStatus.COMPLETED,
          expiresAt: { lt: now },
        },
      });
      expect(prisma.bookingIdempotency.deleteMany).toHaveBeenNthCalledWith(2, {
        where: {
          status: IdempotencyStatus.IN_PROGRESS,
          createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_STALE_MS) },
        },
      });
    });
  });
});
