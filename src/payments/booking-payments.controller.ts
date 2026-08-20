import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service';
import { PaymentSessionsService } from './payment-sessions.service';

type AuthedRequest = Request & { user: { id: string } };

/**
 * The customer-facing half of payments. Mounted under `bookings` because a
 * payment session only ever exists for one booking, but kept in the payments
 * module so the payment dependencies do not leak into `BookingsModule`.
 */
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingPaymentsController {
  constructor(
    private readonly sessions: PaymentSessionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post(':reference/payment-session')
  createSession(
    @Req() req: AuthedRequest,
    @Param('reference') reference: string,
  ) {
    const userId = req.user.id;

    // Tighter than POST /bookings: each session mints a provider order, so an
    // abusive client costs us real Cashfree orders rather than just rows.
    this.rateLimit.consume(`payment-session:user:${userId}`, 10, 5 * 60 * 1000);
    if (req.ip) {
      this.rateLimit.consume(
        `payment-session:ip:${req.ip}`,
        30,
        60 * 60 * 1000,
      );
    }

    return this.sessions.createSession(userId, reference);
  }
}
