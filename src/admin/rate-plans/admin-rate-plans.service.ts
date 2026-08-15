import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { eachNight } from '../admin.utils';
import {
  CreateRatePlanDto,
  UpsertRatePricesDto,
} from '../dto/admin.dto';

@Injectable()
export class AdminRatePlansService {
  constructor(private readonly prisma: PrismaService) {}

  async listForProperty(propertyId: string) {
    return this.prisma.ratePlan.findMany({
      where: { propertyId },
      include: {
        roomType: true,
        mealPlan: true,
        cancellationPolicy: true,
        prices: { orderBy: { date: 'asc' }, take: 30 },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(propertyId: string, dto: CreateRatePlanDto) {
    const roomType = await this.prisma.roomType.findFirst({
      where: { id: dto.roomTypeId, propertyId },
    });
    if (!roomType) throw new NotFoundException('Room type not found');

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

  async upsertPrices(dto: UpsertRatePricesDto) {
    const nights = eachNight(dto.startDate, dto.endDate);
    const currency = dto.currency ?? 'INR';

    await this.prisma.$transaction(
      nights.map((date) =>
        this.prisma.ratePrice.upsert({
          where: {
            ratePlanId_date: { ratePlanId: dto.ratePlanId, date },
          },
          update: {
            basePrice: dto.basePrice,
            currency,
          },
          create: {
            ratePlanId: dto.ratePlanId,
            date,
            basePrice: dto.basePrice,
            currency,
          },
        }),
      ),
    );

    return this.prisma.ratePrice.findMany({
      where: {
        ratePlanId: dto.ratePlanId,
        date: { gte: nights[0], lte: nights[nights.length - 1] },
      },
      orderBy: { date: 'asc' },
    });
  }
}
