import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Prisma } from '../prisma/client';
import { AlterCashService } from '../alter-cash/alter-cash.service';
import { PricingClient } from '../pricing/pricing.types';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { MembershipService } from '../membership/membership.service';
import { BookingInventoryService } from './booking-inventory.service';
import { BookingValidationService } from './booking-validation.service';
import { BookingIntentDto } from './dto/booking-intent.dto';
import { QuoteSelectionDto } from './dto/quote-selection.dto';
import {
  BookingIntentResponse,
  QuoteResponse,
  serializeQuote,
} from './dto/quote-response.dto';
import { CreateBookingDto } from './dto/create-booking.dto';

const DEFAULT_QUOTE_TTL_MINUTES = 15;
const QUOTE_DISPLAY_TTL_SECONDS = 5 * 60;

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly validation: BookingValidationService,
    private readonly pricing: PricingService,
    private readonly inventory: BookingInventoryService,
    private readonly membership: MembershipService,
    private readonly alterCash: AlterCashService,
  ) {}

  get quoteTtlMs(): number {
    const minutes = Number(
      this.config.get<string>('BOOKING_QUOTE_TTL_MINUTES') ??
        DEFAULT_QUOTE_TTL_MINUTES,
    );
    const safe =
      Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_QUOTE_TTL_MINUTES;
    return safe * 60 * 1000;
  }

  async getQuote(dto: QuoteSelectionDto): Promise<QuoteResponse> {
    const { quote, availability } = await this.resolveQuote(dto);
    return this.toQuoteResponse(quote, availability);
  }

  async createIntent(
    userId: string,
    dto: BookingIntentDto,
  ): Promise<BookingIntentResponse> {
    const validated = await this.validation.validate(
      this.selectionToBookingDto(dto),
    );
    const coinsToRedeem = dto.coinsToRedeem ?? 0;
    const { quote, availability } = await this.resolveQuote(
      dto,
      userId,
      coinsToRedeem,
    );

    if (!availability.available) {
      throw new ConflictException(
        'These rooms are no longer available for your dates. Please choose different dates or another room.',
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.quoteTtlMs);
    const token = randomBytes(24).toString('hex');
    const serialized = serializeQuote(quote);

    await this.prisma.bookingQuote.create({
      data: {
        token,
        userId,
        propertyId: validated.property.id,
        roomTypeId: validated.roomType.id,
        ratePlanId: validated.ratePlan.id,
        checkIn: validated.checkIn,
        checkOut: validated.checkOut,
        rooms: validated.rooms,
        adults: validated.adults,
        quoteJson: serialized as unknown as Prisma.InputJsonValue,
        coinsToRedeem,
        expiresAt,
      },
    });

    const coinsBalance = await this.alterCash.getBalance(userId);
    const maxCoinsRedeemable = Math.min(coinsBalance, quote.subtotal);

    return {
      quoteToken: token,
      expiresAt: expiresAt.toISOString(),
      quote: this.toQuoteResponse(quote, availability),
      coinsBalance,
      maxCoinsRedeemable,
      property: {
        name: validated.property.name,
        slug: validated.property.slug,
      },
      roomType: {
        id: validated.roomType.id,
        name: validated.roomType.name,
      },
      ratePlan: {
        id: validated.ratePlan.id,
        name: validated.ratePlan.name,
      },
    };
  }

  async loadConsumableQuote(userId: string, quoteToken: string, dto: CreateBookingDto) {
    const quoteRow = await this.prisma.bookingQuote.findUnique({
      where: { token: quoteToken },
    });

    if (!quoteRow || quoteRow.userId !== userId) {
      throw new NotFoundException('Quote not found or expired');
    }
    if (quoteRow.consumedAt) {
      throw new ConflictException(
        'This checkout session has already been used. Please start checkout again.',
      );
    }
    if (quoteRow.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(
        'Your checkout session expired. Please refresh checkout to get an updated price.',
      );
    }

    const validated = await this.validation.validate(dto);
    this.assertQuoteMatchesSelection(quoteRow, validated);

    const membershipContext = await this.membership.getActiveMembership(userId);
    let quote = await this.prisma.$transaction((tx) =>
      this.pricing.loadAndQuote(
        tx,
        validated.ratePlan.id,
        validated.nights,
        validated.rooms,
        membershipContext
          ? {
              planCode: membershipContext.planCode,
              discountPercent: membershipContext.discountPercent,
            }
          : undefined,
      ),
    );

    const coinsToRedeem = quoteRow.coinsToRedeem ?? 0;
    if (coinsToRedeem > 0) {
      const balance = await this.alterCash.getBalance(userId);
      const preview = this.alterCash.previewRedemption(
        balance,
        quote.subtotal,
        coinsToRedeem,
      );
      if (!preview.valid) {
        throw new BadRequestException(
          preview.reason ?? 'Invalid coin redemption',
        );
      }
      quote = this.pricing.applyCoinRedemption(quote, preview.applied);
    }

    return {
      quoteRow,
      quote,
      validated,
    };
  }

  async markQuoteConsumed(tx: PricingClient, quoteId: string) {
    await tx.bookingQuote.update({
      where: { id: quoteId },
      data: { consumedAt: new Date() },
    });
  }

  private async resolveQuote(
    dto: QuoteSelectionDto,
    userId?: string,
    coinsToRedeem = 0,
  ) {
    const validated = await this.validation.validate(
      this.selectionToBookingDto(dto),
    );

    const membershipContext = userId
      ? await this.membership.getActiveMembership(userId)
      : null;

    let quote = await this.prisma.$transaction((tx) =>
      this.pricing.loadAndQuote(
        tx,
        validated.ratePlan.id,
        validated.nights,
        validated.rooms,
        membershipContext
          ? {
              planCode: membershipContext.planCode,
              discountPercent: membershipContext.discountPercent,
            }
          : undefined,
      ),
    );

    if (userId && coinsToRedeem > 0) {
      const balance = await this.alterCash.getBalance(userId);
      const preview = this.alterCash.previewRedemption(
        balance,
        quote.subtotal,
        coinsToRedeem,
      );
      if (!preview.valid) {
        throw new BadRequestException(
          preview.reason ?? 'Invalid coin redemption',
        );
      }
      quote = this.pricing.applyCoinRedemption(quote, preview.applied);
    }

    const availability = await this.inventory.readAvailability(
      this.prisma,
      validated.roomType.id,
      validated.nights,
      validated.rooms,
    );

    return { quote, availability, validated };
  }

  private toQuoteResponse(
    quote: ReturnType<PricingService['computeQuote']>,
    availability: { available: boolean; remainingRooms: number },
  ): QuoteResponse {
    const expiresAt = new Date(
      Date.now() + QUOTE_DISPLAY_TTL_SECONDS * 1000,
    ).toISOString();

    return {
      subtotal: quote.subtotal,
      taxAmount: quote.taxAmount,
      discountAmount: quote.discountAmount,
      totalAmount: quote.totalAmount,
      currency: quote.currency,
      nights: quote.nights,
      rooms: quote.rooms,
      available: availability.available,
      remainingRooms: availability.remainingRooms,
      expiresAt,
      coinEarnPreview: quote.coinEarnPreview,
      coinsRedeemed: quote.coinsRedeemed,
    };
  }

  private selectionToBookingDto(dto: QuoteSelectionDto): CreateBookingDto {
    return {
      ...dto,
      quoteToken: 'quote-preview',
      guest: { firstName: 'Quote' },
    };
  }

  private assertQuoteMatchesSelection(
    quoteRow: {
      propertyId: string;
      roomTypeId: string;
      ratePlanId: string;
      checkIn: Date;
      checkOut: Date;
      rooms: number;
      adults: number;
    },
    validated: Awaited<ReturnType<BookingValidationService['validate']>>,
  ) {
    const mismatches: string[] = [];
    if (quoteRow.propertyId !== validated.property.id) mismatches.push('property');
    if (quoteRow.roomTypeId !== validated.roomType.id) mismatches.push('room');
    if (quoteRow.ratePlanId !== validated.ratePlan.id) mismatches.push('rate plan');
    if (quoteRow.checkIn.getTime() !== validated.checkIn.getTime()) {
      mismatches.push('check-in');
    }
    if (quoteRow.checkOut.getTime() !== validated.checkOut.getTime()) {
      mismatches.push('check-out');
    }
    if (quoteRow.rooms !== validated.rooms) mismatches.push('rooms');
    if (quoteRow.adults !== validated.adults) mismatches.push('guests');

    if (mismatches.length) {
      throw new ConflictException(
        'Your checkout details changed. Please refresh checkout and try again.',
      );
    }
  }
}
