import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eachNight, parseIsoDate } from '../admin/admin.utils';
import { PrismaService } from '../prisma/prisma.service';
import { PropertyStatus } from '../prisma/client';
import { CreateBookingDto } from './dto/create-booking.dto';

/**
 * Upper bound on stay length. Also a safety valve: every night in the request
 * becomes a locked `room_inventory` row and an `inventory_holds` insert, so an
 * unbounded range would let one request lock a year of inventory.
 */
export const MAX_STAY_NIGHTS = 30;

export type ValidatedBooking = {
  property: { id: string; name: string; slug: string };
  roomType: { id: string; name: string; maxOccupancy: number };
  ratePlan: {
    id: string;
    name: string;
    mealPlanName: string | null;
    cancellationPolicyText: string | null;
  };
  checkIn: Date;
  checkOut: Date;
  nights: Date[];
  rooms: number;
  adults: number;
};

/**
 * Resolves and authorizes the request's references before any transaction is
 * opened. Purely advisory with respect to price and availability — it exists to
 * turn bad input into a fast, specific 4xx.
 */
@Injectable()
export class BookingValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(dto: CreateBookingDto): Promise<ValidatedBooking> {
    const { checkIn, checkOut, nights } = this.validateDates(
      dto.checkIn,
      dto.checkOut,
    );

    const property = await this.prisma.property.findFirst({
      where: { slug: dto.propertySlug, status: PropertyStatus.ACTIVE },
      select: { id: true, name: true, slug: true },
    });
    if (!property) {
      throw new NotFoundException('Property not found');
    }

    const roomType = await this.prisma.roomType.findFirst({
      where: {
        id: dto.roomTypeId,
        propertyId: property.id,
        status: 'ACTIVE',
      },
      select: { id: true, name: true, maxOccupancy: true },
    });
    if (!roomType) {
      throw new NotFoundException('Room type not available for this property');
    }

    const ratePlan = await this.prisma.ratePlan.findFirst({
      where: {
        id: dto.ratePlanId,
        roomTypeId: roomType.id,
        propertyId: property.id,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        mealPlan: { select: { name: true } },
        cancellationPolicy: { select: { name: true, description: true } },
      },
    });
    if (!ratePlan) {
      throw new NotFoundException('Rate plan not available for this room type');
    }

    this.validateOccupancy(dto.adults, dto.rooms, roomType.maxOccupancy);

    return {
      property,
      roomType,
      ratePlan: {
        id: ratePlan.id,
        name: ratePlan.name,
        mealPlanName: ratePlan.mealPlan?.name ?? null,
        cancellationPolicyText: ratePlan.cancellationPolicy
          ? `${ratePlan.cancellationPolicy.name}: ${ratePlan.cancellationPolicy.description}`
          : null,
      },
      checkIn,
      checkOut,
      nights,
      rooms: dto.rooms,
      adults: dto.adults,
    };
  }

  validateDates(checkInRaw: string, checkOutRaw: string) {
    const checkIn = parseIsoDate(checkInRaw.slice(0, 10));
    const checkOut = parseIsoDate(checkOutRaw.slice(0, 10));

    if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime())) {
      throw new BadRequestException('checkIn and checkOut must be valid dates');
    }
    if (checkOut <= checkIn) {
      throw new BadRequestException('checkOut must be after checkIn');
    }

    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    if (checkIn < todayUtc) {
      throw new BadRequestException('checkIn cannot be in the past');
    }

    const nights = eachNight(checkInRaw.slice(0, 10), checkOutRaw.slice(0, 10));
    if (nights.length > MAX_STAY_NIGHTS) {
      throw new BadRequestException(
        `Stays longer than ${MAX_STAY_NIGHTS} nights cannot be booked online`,
      );
    }

    return { checkIn, checkOut, nights };
  }

  validateOccupancy(adults: number, rooms: number, maxOccupancy: number): void {
    const perRoom = Math.ceil(adults / rooms);
    if (perRoom > maxOccupancy) {
      throw new BadRequestException(
        `This room type sleeps at most ${maxOccupancy} guest(s) per room; ` +
          `${adults} guest(s) across ${rooms} room(s) needs ${perRoom}`,
      );
    }
  }
}
