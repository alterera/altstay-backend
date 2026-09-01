import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingIntentDto } from './dto/booking-intent.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';

type AuthedRequest = Request & { user: { id: string } };

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('intent')
  createIntent(@Req() req: AuthedRequest, @Body() dto: BookingIntentDto) {
    return this.bookings.createIntent(req.user.id, dto);
  }

  @Post()
  create(
    @Req() req: AuthedRequest,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const userId = req.user.id;

    this.rateLimit.consume(`booking:user:${userId}`, 10, 5 * 60 * 1000);
    if (req.ip) {
      this.rateLimit.consume(`booking:ip:${req.ip}`, 30, 60 * 60 * 1000);
    }

    return this.bookings.createBooking(
      userId,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  // Declared before the :reference route so the literal path is not swallowed by
  // the parameter.
  @Get('me')
  listMine(@Req() req: AuthedRequest, @Query() query: ListBookingsQueryDto) {
    return this.bookings.listForUser(req.user.id, query);
  }

  @Post(':reference/extend-hold')
  extendHold(
    @Req() req: AuthedRequest,
    @Param('reference') reference: string,
  ) {
    return this.bookings.tryExtendHold(req.user.id, reference);
  }

  @Get(':reference')
  findOne(@Req() req: AuthedRequest, @Param('reference') reference: string) {
    // Phase C polls this after checkout; a dedicated bucket keeps a refresh loop
    // from competing with booking-create limits.
    this.rateLimit.consume(`booking-read:user:${req.user.id}`, 60, 60 * 1000);
    return this.bookings.findByReference(req.user.id, reference);
  }

  private requireIdempotencyKey(key?: string): string {
    const trimmed = key?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        'An Idempotency-Key header is required to create a booking',
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
      throw new BadRequestException(
        'Idempotency-Key must be 8-128 characters of letters, digits, dot, underscore, colon or hyphen',
      );
    }
    return trimmed;
  }
}
