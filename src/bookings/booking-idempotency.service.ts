import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IdempotencyStatus, Prisma } from '../prisma/client';
import { PricingClient } from '../pricing/pricing.types';
import { PrismaService } from '../prisma/prisma.service';

/** How long a key maps to its original booking. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A claim left IN_PROGRESS for longer than this belongs to a request that died
 * before it could finish, and is safe to sweep.
 */
export const IDEMPOTENCY_STALE_MS = 5 * 60 * 1000;

export type ClaimResult =
  | { outcome: 'ACQUIRED'; claimId: string }
  | { outcome: 'REPLAY'; reservationId: string };

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Stable JSON: key order must not change the hash. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) acc[key] = canonicalize(entry);
        return acc;
      }, {});
  }
  return value;
}

@Injectable()
export class BookingIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  hashRequest(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(canonicalize(body)))
      .digest('hex');
  }

  /**
   * Attempts to take ownership of `(userId, idempotencyKey)` by inserting the
   * claim row and letting the unique index arbitrate.
   *
   * This is deliberately not a read-then-write check. Two simultaneous requests
   * carrying the same key both reach the INSERT; PostgreSQL lets exactly one
   * through and rejects the other with a unique violation, which is the only
   * race-free way to decide a winner.
   *
   * @returns ACQUIRED for the winner, or REPLAY when the key already produced a
   * booking (the lost-response retry case).
   * @throws 409 when the key was reused with a different body, or when a sibling
   * request still holds the claim.
   */
  async claim(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    now: Date = new Date(),
  ): Promise<ClaimResult> {
    try {
      const created = await this.prisma.bookingIdempotency.create({
        data: {
          userId,
          idempotencyKey,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
        select: { id: true },
      });
      return { outcome: 'ACQUIRED', claimId: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.resolveExistingClaim(userId, idempotencyKey, requestHash);
    }
  }

  private async resolveExistingClaim(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ClaimResult> {
    const existing = await this.prisma.bookingIdempotency.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });

    // The cleanup job deleted the row between our INSERT failing and this read.
    // Rare, and a plain retry resolves it.
    if (!existing) {
      throw this.retryable(
        'Could not reserve this Idempotency-Key. Please retry.',
      );
    }

    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different booking request',
      );
    }

    if (
      existing.status === IdempotencyStatus.COMPLETED &&
      existing.reservationId
    ) {
      return { outcome: 'REPLAY', reservationId: existing.reservationId };
    }

    throw this.retryable(
      'A booking with this Idempotency-Key is already being processed',
    );
  }

  /**
   * Flips the claim to COMPLETED. Called with the booking transaction's client so
   * that a committed reservation always has a committed claim pointing at it —
   * otherwise a retry could slip through and double-book.
   */
  async markCompleted(
    tx: PricingClient,
    claimId: string,
    reservationId: string,
  ): Promise<void> {
    await tx.bookingIdempotency.update({
      where: { id: claimId },
      data: { status: IdempotencyStatus.COMPLETED, reservationId },
    });
  }

  /**
   * Drops a claim whose booking transaction rolled back, so the caller can retry
   * with the same key. Best-effort: if this fails, the stale sweep handles it.
   */
  async release(claimId: string): Promise<void> {
    await this.prisma.bookingIdempotency
      .delete({ where: { id: claimId } })
      .catch(() => undefined);
  }

  /**
   * Frees keys for reuse. The unique index means `expiresAt` alone changes
   * nothing — a key is only reusable once its row is actually gone.
   */
  async cleanup(now: Date = new Date()): Promise<{
    expired: number;
    stale: number;
  }> {
    const expired = await this.prisma.bookingIdempotency.deleteMany({
      where: { status: IdempotencyStatus.COMPLETED, expiresAt: { lt: now } },
    });
    const stale = await this.prisma.bookingIdempotency.deleteMany({
      where: {
        status: IdempotencyStatus.IN_PROGRESS,
        createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_STALE_MS) },
      },
    });
    return { expired: expired.count, stale: stale.count };
  }

  private retryable(message: string): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.CONFLICT,
        message,
        retryAfterSec: 2,
      },
      HttpStatus.CONFLICT,
    );
  }
}
