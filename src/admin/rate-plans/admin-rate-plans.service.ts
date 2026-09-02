import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertDateRange, parseIsoDate } from '../admin.utils';
import {
  CreateRatePlanDto,
  UpdateRatePlanDto,
  UpsertRatePricesDto,
} from '../dto/admin.dto';
import { AdminRoomTypesService } from '../room-types/admin-room-types.service';

const RATE_PLAN_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

@Injectable()
export class AdminRatePlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roomTypes: AdminRoomTypesService,
  ) {}

  async listForProperty(propertyId: string) {
    return this.prisma.ratePlan.findMany({
      where: { propertyId },
      include: {
        roomType: true,
        mealPlan: true,
        cancellationPolicy: true,
        _count: { select: { reservationItems: true, prices: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getById(propertyId: string, ratePlanId: string) {
    const plan = await this.prisma.ratePlan.findFirst({
      where: { id: ratePlanId, propertyId },
      include: {
        roomType: true,
        mealPlan: true,
        cancellationPolicy: true,
        _count: { select: { reservationItems: true, prices: true } },
      },
    });
    if (!plan) throw new NotFoundException('Rate plan not found');
    return plan;
  }

  async create(propertyId: string, dto: CreateRatePlanDto) {
    await this.roomTypes.assertRoomType(propertyId, dto.roomTypeId);

    return this.prisma.ratePlan.create({
      data: {
        propertyId,
        roomTypeId: dto.roomTypeId,
        name: dto.name,
        description: dto.description,
        mealPlanId: dto.mealPlanId,
        cancellationPolicyId: dto.cancellationPolicyId,
      },
      include: {
        roomType: true,
        mealPlan: true,
        cancellationPolicy: true,
      },
    });
  }

  async update(
    propertyId: string,
    ratePlanId: string,
    dto: UpdateRatePlanDto,
  ) {
    await this.getById(propertyId, ratePlanId);
    if (
      dto.status !== undefined &&
      !RATE_PLAN_STATUSES.includes(dto.status as typeof RATE_PLAN_STATUSES[number])
    ) {
      throw new BadRequestException(
        `status must be one of: ${RATE_PLAN_STATUSES.join(', ')}`,
      );
    }

    return this.prisma.ratePlan.update({
      where: { id: ratePlanId },
      data: dto,
      include: {
        roomType: true,
        mealPlan: true,
        cancellationPolicy: true,
      },
    });
  }

  async remove(propertyId: string, ratePlanId: string) {
    await this.getById(propertyId, ratePlanId);

    const bookingCount = await this.prisma.reservationItem.count({
      where: { ratePlanId },
    });
    if (bookingCount > 0) {
      throw new ConflictException(
        'Cannot delete: this rate plan has booking history. Set status to INACTIVE instead.',
      );
    }

    await this.prisma.ratePlan.delete({ where: { id: ratePlanId } });
    return { success: true };
  }

  async listPrices(
    propertyId: string,
    ratePlanId: string,
    from?: string,
    to?: string,
  ) {
    await this.getById(propertyId, ratePlanId);

    const where: { ratePlanId: string; date?: { gte?: Date; lt?: Date } } = {
      ratePlanId,
    };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = parseIsoDate(from);
      if (to) where.date.lt = parseIsoDate(to);
    }

    return this.prisma.ratePrice.findMany({
      where,
      orderBy: { date: 'asc' },
    });
  }

  async upsertPrices(
    propertyId: string,
    ratePlanId: string,
    dto: UpsertRatePricesDto,
  ) {
    await this.getById(propertyId, ratePlanId);
    const nights = assertDateRange(dto.startDate, dto.endDate);
    const currency = dto.currency ?? 'INR';

    await this.prisma.$transaction(
      nights.map((date) =>
        this.prisma.ratePrice.upsert({
          where: {
            ratePlanId_date: { ratePlanId, date },
          },
          update: {
            basePrice: dto.basePrice,
            currency,
          },
          create: {
            ratePlanId,
            date,
            basePrice: dto.basePrice,
            currency,
          },
        }),
      ),
    );

    return this.listPrices(propertyId, ratePlanId, dto.startDate, dto.endDate);
  }

  async deletePrices(
    propertyId: string,
    ratePlanId: string,
    startDate: string,
    endDate: string,
  ) {
    await this.getById(propertyId, ratePlanId);
    const nights = assertDateRange(startDate, endDate);
    const rangeStart = parseIsoDate(startDate);
    const rangeEnd = parseIsoDate(endDate);

    const overlapping = await this.prisma.reservationItem.count({
      where: {
        ratePlanId,
        checkIn: { lt: rangeEnd },
        checkOut: { gt: rangeStart },
      },
    });
    if (overlapping > 0) {
      throw new ConflictException(
        'Cannot delete prices: bookings exist for this rate plan in the selected date range.',
      );
    }

    const result = await this.prisma.ratePrice.deleteMany({
      where: {
        ratePlanId,
        date: { in: nights },
      },
    });

    return { deleted: result.count };
  }
}
