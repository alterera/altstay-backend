import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingIdempotencyService } from './booking-idempotency.service';
import { BookingsService } from './bookings.service';

/**
 * Background upkeep for the booking domain: releasing inventory the guest never
 * paid for, and freeing idempotency keys.
 */
@Injectable()
export class BookingMaintenanceService {
  private readonly logger = new Logger(BookingMaintenanceService.name);
  private expiryRunning = false;
  private completionRunning = false;

  constructor(
    private readonly bookings: BookingsService,
    private readonly idempotency: BookingIdempotencyService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireHolds(): Promise<number> {
    // A previous tick still working means the queue is long; overlapping runs
    // would only contend on the same row locks.
    if (this.expiryRunning) return 0;
    this.expiryRunning = true;

    try {
      const candidates = await this.bookings.findExpiredHoldCandidates();
      if (!candidates.length) return 0;

      let expired = 0;
      for (const reservationId of candidates) {
        try {
          // Each reservation gets its own transaction, and re-checks its status
          // under a row lock before being expired.
          if (await this.bookings.expireReservation(reservationId)) {
            expired += 1;
          }
        } catch (error) {
          // One poisoned reservation must not stall the rest of the queue.
          this.logger.error(
            `Failed to expire reservation ${reservationId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (expired) {
        this.logger.log(`Expired ${expired} reservation hold(s)`);
      }
      return expired;
    } finally {
      this.expiryRunning = false;
    }
  }

  /** Daily: mark past check-outs COMPLETED and credit member coins. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async completePastStays(): Promise<number> {
    if (this.completionRunning) return 0;
    this.completionRunning = true;

    try {
      const candidates = await this.bookings.findCompletionCandidates();
      if (!candidates.length) return 0;

      let completed = 0;
      for (const reservationId of candidates) {
        try {
          if (await this.bookings.completeStay(reservationId)) {
            completed += 1;
          }
        } catch (error) {
          this.logger.error(
            `Failed to complete reservation ${reservationId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (completed) {
        this.logger.log(`Completed ${completed} reservation(s) after check-out`);
      }
      return completed;
    } finally {
      this.completionRunning = false;
    }
  }

  /**
   * Deleting the row is what actually frees a key. `expiresAt` on its own cannot,
   * because the unique index on (userId, idempotencyKey) still matches.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanupIdempotencyKeys(): Promise<void> {
    try {
      const { expired, stale } = await this.idempotency.cleanup();
      if (expired || stale) {
        this.logger.log(
          `Cleaned idempotency claims: ${expired} expired, ${stale} stale`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Idempotency cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
