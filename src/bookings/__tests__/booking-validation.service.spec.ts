import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BookingValidationService,
  MAX_STAY_NIGHTS,
} from '../booking-validation.service';
import { CreateBookingDto } from '../dto/create-booking.dto';

const PROPERTY = { id: 'prop-1', name: 'Hotel Alpha', slug: 'hotel-alpha' };
const ROOM_TYPE = { id: 'room-1', name: 'Deluxe King', maxOccupancy: 3 };
const RATE_PLAN = {
  id: 'rate-1',
  name: 'Breakfast Included',
  mealPlan: { name: 'Breakfast' },
  cancellationPolicy: { name: 'Flexible', description: 'Free until 24h prior' },
};

/** A date far enough ahead that the "not in the past" rule never trips. */
function futureDates(nights = 2) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 30);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + nights);
  return {
    checkIn: start.toISOString().slice(0, 10),
    checkOut: end.toISOString().slice(0, 10),
  };
}

function dto(overrides: Partial<CreateBookingDto> = {}): CreateBookingDto {
  return {
    propertySlug: 'hotel-alpha',
    roomTypeId: ROOM_TYPE.id,
    ratePlanId: RATE_PLAN.id,
    ...futureDates(),
    rooms: 1,
    adults: 2,
    guest: { firstName: 'Asha' },
    quoteToken: 'test-quote-token',
    ...overrides,
  };
}

describe('BookingValidationService', () => {
  let prisma: {
    property: { findFirst: jest.Mock };
    roomType: { findFirst: jest.Mock };
    ratePlan: { findFirst: jest.Mock };
  };
  let validation: BookingValidationService;

  beforeEach(() => {
    prisma = {
      property: { findFirst: jest.fn().mockResolvedValue(PROPERTY) },
      roomType: { findFirst: jest.fn().mockResolvedValue(ROOM_TYPE) },
      ratePlan: { findFirst: jest.fn().mockResolvedValue(RATE_PLAN) },
    };
    validation = new BookingValidationService(
      prisma as unknown as PrismaService,
    );
  });

  describe('validate', () => {
    it('resolves the slug, room type and rate plan into a booking context', async () => {
      const result = await validation.validate(dto());

      expect(result.property).toEqual(PROPERTY);
      expect(result.roomType).toEqual(ROOM_TYPE);
      expect(result.ratePlan).toEqual({
        id: 'rate-1',
        name: 'Breakfast Included',
        mealPlanName: 'Breakfast',
        cancellationPolicyText: 'Flexible: Free until 24h prior',
      });
      expect(result.nights).toHaveLength(2);
    });

    it('only accepts an ACTIVE property', async () => {
      await validation.validate(dto());

      expect(prisma.property.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'hotel-alpha', status: 'ACTIVE' },
        }),
      );
    });

    it('scopes the room type to the resolved property', async () => {
      await validation.validate(dto());

      expect(prisma.roomType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: ROOM_TYPE.id,
            propertyId: PROPERTY.id,
            status: 'ACTIVE',
          },
        }),
      );
    });

    it('scopes the rate plan to both the room type and the property', async () => {
      await validation.validate(dto());

      expect(prisma.ratePlan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: RATE_PLAN.id,
            roomTypeId: ROOM_TYPE.id,
            propertyId: PROPERTY.id,
            status: 'ACTIVE',
          },
        }),
      );
    });

    it('rejects an unknown or inactive property', async () => {
      prisma.property.findFirst.mockResolvedValue(null);

      await expect(validation.validate(dto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a room type belonging to another property', async () => {
      prisma.roomType.findFirst.mockResolvedValue(null);

      await expect(validation.validate(dto())).rejects.toThrow(
        /Room type not available/,
      );
    });

    it('rejects a rate plan belonging to another room type', async () => {
      prisma.ratePlan.findFirst.mockResolvedValue(null);

      await expect(validation.validate(dto())).rejects.toThrow(
        /Rate plan not available/,
      );
    });

    it('leaves optional rate plan relations null', async () => {
      prisma.ratePlan.findFirst.mockResolvedValue({
        id: 'rate-1',
        name: 'Room Only',
        mealPlan: null,
        cancellationPolicy: null,
      });

      const result = await validation.validate(dto());

      expect(result.ratePlan.mealPlanName).toBeNull();
      expect(result.ratePlan.cancellationPolicyText).toBeNull();
    });
  });

  describe('validateDates', () => {
    it('expands the range into one night per stayed date', () => {
      const { nights, checkIn, checkOut } = validation.validateDates(
        '2099-03-01',
        '2099-03-04',
      );

      expect(nights.map((n) => n.toISOString().slice(0, 10))).toEqual([
        '2099-03-01',
        '2099-03-02',
        '2099-03-03',
      ]);
      expect(checkIn.toISOString()).toBe('2099-03-01T00:00:00.000Z');
      expect(checkOut.toISOString()).toBe('2099-03-04T00:00:00.000Z');
    });

    it('rejects a checkout on or before check-in', () => {
      expect(() =>
        validation.validateDates('2099-03-01', '2099-03-01'),
      ).toThrow(/checkOut must be after checkIn/);
      expect(() =>
        validation.validateDates('2099-03-02', '2099-03-01'),
      ).toThrow(BadRequestException);
    });

    it('rejects a check-in in the past', () => {
      expect(() =>
        validation.validateDates('2020-01-01', '2020-01-02'),
      ).toThrow(/checkIn cannot be in the past/);
    });

    it('caps the stay length', () => {
      const start = new Date('2099-03-01T00:00:00.000Z');
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + MAX_STAY_NIGHTS + 1);

      expect(() =>
        validation.validateDates('2099-03-01', end.toISOString().slice(0, 10)),
      ).toThrow(new RegExp(`longer than ${MAX_STAY_NIGHTS} nights`));
    });

    it('allows a stay of exactly the maximum length', () => {
      const start = new Date('2099-03-01T00:00:00.000Z');
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + MAX_STAY_NIGHTS);

      expect(
        validation.validateDates('2099-03-01', end.toISOString().slice(0, 10))
          .nights,
      ).toHaveLength(MAX_STAY_NIGHTS);
    });
  });

  describe('validateOccupancy', () => {
    it('accepts guests that fit within the per-room maximum', () => {
      expect(() => validation.validateOccupancy(6, 2, 3)).not.toThrow();
    });

    it('rejects guests that exceed the per-room maximum', () => {
      expect(() => validation.validateOccupancy(7, 2, 3)).toThrow(
        /sleeps at most 3 guest\(s\) per room/,
      );
    });

    it('rounds partially filled rooms up', () => {
      // 5 guests across 2 rooms needs a room holding 3.
      expect(() => validation.validateOccupancy(5, 2, 2)).toThrow(
        BadRequestException,
      );
      expect(() => validation.validateOccupancy(5, 2, 3)).not.toThrow();
    });
  });
});
