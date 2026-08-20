import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { RateLimitService } from '../../src/auth/rate-limit/rate-limit.service';
import { BookingIdempotencyService } from '../../src/bookings/booking-idempotency.service';
import { BookingMaintenanceService } from '../../src/bookings/booking-maintenance.service';
import { BookingsService } from '../../src/bookings/bookings.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  OrganizationType,
  PropertyStatus,
  UserStatus,
} from '../../src/prisma/client';

export type TestUser = { id: string; phone: string; token: string };

export type BookingBody = {
  reservationNumber: string;
  status: string;
  property: { name: string; slug: string };
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  holdExpiresAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  payment: {
    status: string;
    paymentReference: string;
    paidAt: string | null;
    refundRequired: boolean;
    failureReason: string | null;
  } | null;
  businessBooking: {
    companyName: string;
    gstin: string | null;
    billingAddress: string | null;
  } | null;
  guests: {
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  }[];
  items: { roomTypeName: string; ratePlanName: string; quantity: number }[];
};

export type BookingListBody = {
  results: BookingBody[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

export type ErrorBody = {
  statusCode: number;
  message: string | string[];
  retryAfterSec?: number;
};

// supertest types `body` as `any`. These narrow it once, at the boundary, so the
// specs themselves stay type-checked.
export function bookingOf(res: Response): BookingBody {
  return res.body as BookingBody;
}

export function listOf(res: Response): BookingListBody {
  return res.body as BookingListBody;
}

export function errorOf(res: Response): ErrorBody {
  return res.body as ErrorBody;
}

export type BookingFixtureOptions = {
  /** Rooms loaded into inventory for every night of the stay. */
  totalRooms?: number;
  /** Number of users to provision with valid JWTs. */
  users?: number;
  nights?: number;
  nightlyRate?: number;
  /**
   * Rate limiting is disabled by default so a suite firing many bookings in a
   * row measures locking rather than throttling. The API suite turns it back on
   * to assert the limiter itself.
   */
  enableRateLimit?: boolean;
};

/**
 * Boots the real application against PostgreSQL and seeds an isolated property.
 *
 * Everything is namespaced with a random suffix and removed in `teardown`, so the
 * suites are safe to run against a shared database when TEST_DATABASE_URL is not
 * configured.
 */
export class BookingFixture {
  app!: INestApplication<App>;
  prisma!: PrismaService;
  bookings!: BookingsService;
  maintenance!: BookingMaintenanceService;
  idempotency!: BookingIdempotencyService;

  propertyId!: string;
  propertySlug!: string;
  roomTypeId!: string;
  ratePlanId!: string;
  organizationId!: string;
  createdPropertyTypeId: string | null = null;

  users: TestUser[] = [];
  checkIn!: string;
  checkOut!: string;
  nightlyRate!: number;
  nightCount!: number;

  private readonly tag = randomUUID().slice(0, 8);

  async setup(options: BookingFixtureOptions = {}): Promise<void> {
    const {
      totalRooms = 2,
      users = 2,
      nights = 2,
      nightlyRate = 1000,
      enableRateLimit = false,
    } = options;

    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (!enableRateLimit) {
      builder.overrideProvider(RateLimitService).useValue({
        consume: () => Number.MAX_SAFE_INTEGER,
      });
    }
    const moduleRef = await builder.compile();

    // rawBody mirrors the real bootstrap: without it the payment-notification
    // signature guard has nothing to verify against. Note the options go in the
    // first argument — TestingModule discards the second unless the first is an
    // HTTP adapter.
    this.app = moduleRef.createNestApplication({ rawBody: true });
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await this.app.init();

    this.prisma = this.app.get(PrismaService);
    this.bookings = this.app.get(BookingsService);
    this.maintenance = this.app.get(BookingMaintenanceService);
    this.idempotency = this.app.get(BookingIdempotencyService);

    this.nightlyRate = nightlyRate;
    this.nightCount = nights;
    const stayDates = this.buildStayDates(nights);
    this.checkIn = stayDates.checkIn;
    this.checkOut = stayDates.checkOut;

    await this.seedProperty(totalRooms, stayDates.nights, nightlyRate);
    await this.seedUsers(users);
  }

  /** Stay well into the future so the "no past check-in" rule never interferes. */
  private buildStayDates(nights: number) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + 90);

    const nightDates: Date[] = [];
    for (let i = 0; i < nights; i += 1) {
      const night = new Date(start);
      night.setUTCDate(night.getUTCDate() + i);
      nightDates.push(night);
    }

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + nights);

    return {
      checkIn: start.toISOString().slice(0, 10),
      checkOut: end.toISOString().slice(0, 10),
      nights: nightDates,
    };
  }

  private async seedProperty(
    totalRooms: number,
    nights: Date[],
    nightlyRate: number,
  ): Promise<void> {
    const organization = await this.prisma.organization.create({
      data: {
        name: `E2E Bookings Org ${this.tag}`,
        type: OrganizationType.HOTEL_OPERATOR,
      },
      select: { id: true },
    });
    this.organizationId = organization.id;

    // Reuse a seeded property type when one exists so we do not accumulate rows.
    const existingType = await this.prisma.propertyType.findFirst({
      select: { id: true },
    });
    let propertyTypeId = existingType?.id;
    if (!propertyTypeId) {
      const created = await this.prisma.propertyType.create({
        data: { code: `E2E_${this.tag}`, name: 'E2E Hotel' },
        select: { id: true },
      });
      propertyTypeId = created.id;
      this.createdPropertyTypeId = created.id;
    }

    this.propertySlug = `e2e-booking-hotel-${this.tag}`;
    const property = await this.prisma.property.create({
      data: {
        organizationId: this.organizationId,
        propertyTypeId,
        name: `E2E Booking Hotel ${this.tag}`,
        slug: this.propertySlug,
        status: PropertyStatus.ACTIVE,
        checkInTime: '14:00',
        checkOutTime: '11:00',
        roomTypes: {
          create: [
            {
              name: 'E2E Deluxe King',
              description: 'Fixture room type',
              maxAdults: 2,
              maxChildren: 1,
              maxOccupancy: 3,
              bedType: 'King',
              status: 'ACTIVE',
            },
          ],
        },
      },
      select: { id: true, roomTypes: { select: { id: true } } },
    });
    this.propertyId = property.id;
    this.roomTypeId = property.roomTypes[0].id;

    const ratePlan = await this.prisma.ratePlan.create({
      data: {
        propertyId: this.propertyId,
        roomTypeId: this.roomTypeId,
        name: 'E2E Room Only',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    this.ratePlanId = ratePlan.id;

    await this.prisma.roomInventory.createMany({
      data: nights.map((date) => ({
        roomTypeId: this.roomTypeId,
        date,
        totalRooms,
        blockedRooms: 0,
        soldRooms: 0,
      })),
    });

    await this.prisma.ratePrice.createMany({
      data: nights.map((date) => ({
        ratePlanId: this.ratePlanId,
        date,
        basePrice: nightlyRate,
        currency: 'INR',
      })),
    });
  }

  private async seedUsers(count: number): Promise<void> {
    const jwt = this.app.get(JwtService);

    for (let i = 0; i < count; i += 1) {
      const phone = `+9199${String(Date.now()).slice(-6)}${String(i).padStart(2, '0')}`;
      const user = await this.prisma.user.create({
        data: {
          phone,
          firstName: `E2E${i}`,
          lastName: 'Tester',
          status: UserStatus.ACTIVE,
          mobileVerifiedAt: new Date(),
        },
        select: { id: true, phone: true },
      });

      this.users.push({
        id: user.id,
        phone: user.phone,
        token: jwt.sign({ sub: user.id, phone: user.phone }),
      });
    }
  }

  bookingBody(overrides: Record<string, unknown> = {}) {
    return {
      propertySlug: this.propertySlug,
      roomTypeId: this.roomTypeId,
      ratePlanId: this.ratePlanId,
      checkIn: this.checkIn,
      checkOut: this.checkOut,
      rooms: 1,
      adults: 2,
      guest: {
        firstName: 'Asha',
        lastName: 'Rao',
        email: 'asha@example.com',
        phone: '+919812345678',
      },
      ...overrides,
    };
  }

  postBooking(
    user: TestUser,
    body: Record<string, unknown> = this.bookingBody(),
    idempotencyKey: string = randomUUID(),
  ) {
    return request(this.app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  get http() {
    return request(this.app.getHttpServer());
  }

  /** Rewinds a reservation's hold so the expiry job treats it as overdue. */
  async forceHoldExpiry(reservationNumber: string): Promise<void> {
    const past = new Date(Date.now() - 60_000);
    const reservation = await this.prisma.reservation.update({
      where: { reservationNumber },
      data: { holdExpiresAt: past },
      select: { id: true },
    });
    await this.prisma.inventoryHold.updateMany({
      where: { reservationId: reservation.id },
      data: { expiresAt: past },
    });
  }

  async reservationByNumber(reservationNumber: string) {
    return this.prisma.reservation.findUnique({
      where: { reservationNumber },
      include: { items: true, guests: true, inventoryHolds: true },
    });
  }

  async holdsForFixture() {
    return this.prisma.inventoryHold.findMany({
      where: { roomTypeId: this.roomTypeId },
      orderBy: { date: 'asc' },
    });
  }

  async teardown(): Promise<void> {
    if (!this.prisma) return;

    const userIds = this.users.map((user) => user.id);

    // Payments restrict deletion of reservations, which in turn restrict users and
    // properties, so the teardown unwinds in that order. Items, guests, holds and
    // status history all cascade from the reservation.
    await this.prisma.payment.deleteMany({
      where: { reservation: { propertyId: this.propertyId } },
    });
    await this.prisma.reservation.deleteMany({
      where: { propertyId: this.propertyId },
    });
    if (userIds.length) {
      await this.prisma.payment.deleteMany({
        where: { reservation: { userId: { in: userIds } } },
      });
      await this.prisma.reservation.deleteMany({
        where: { userId: { in: userIds } },
      });
      await this.prisma.bookingIdempotency.deleteMany({
        where: { userId: { in: userIds } },
      });
    }

    await this.prisma.property.deleteMany({ where: { id: this.propertyId } });
    await this.prisma.organization.deleteMany({
      where: { id: this.organizationId },
    });
    if (this.createdPropertyTypeId) {
      await this.prisma.propertyType.deleteMany({
        where: { id: this.createdPropertyTypeId },
      });
    }
    if (userIds.length) {
      await this.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await this.app.close();
  }
}
