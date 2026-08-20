import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PricingClient } from '../pricing/pricing.types';

/**
 * Crockford base32: no I, L, O or U, so the reference can be read aloud or typed
 * from a screenshot without ambiguity.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LENGTH = 6;
const MAX_ATTEMPTS = 5;

@Injectable()
export class BookingNumberService {
  /**
   * `ALTSTAY-20260819-4F7K2Q`.
   *
   * This is a customer-facing reference, NOT a credential. Knowing a reservation
   * number must never grant access to it — see the ownership check in
   * `BookingsService.findByReference`.
   */
  generate(now: Date = new Date()): string {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');

    let random = '';
    for (let i = 0; i < RANDOM_LENGTH; i += 1) {
      random += ALPHABET[randomInt(ALPHABET.length)];
    }

    return `ALTSTAY-${yyyy}${mm}${dd}-${random}`;
  }

  /**
   * Picks a number that is free at read time. The keyspace is 32^6 (~1.07bn) per
   * day, so this loop effectively never repeats; the unique index on
   * `reservationNumber` remains the real guarantee and the caller retries the
   * transaction if it ever fires.
   */
  async generateUnique(client: PricingClient, now?: Date): Promise<string> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const candidate = this.generate(now);
      const existing = await client.reservation.findUnique({
        where: { reservationNumber: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    throw new InternalServerErrorException(
      'Could not allocate a reservation number',
    );
  }
}
