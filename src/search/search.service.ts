import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PropertyStatus } from '../prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { eachNight } from '../admin/admin.utils';
import { S3Service } from '../admin/uploads/s3.service';
import { PricingService } from '../pricing/pricing.service';
import {
  matchesPriceBucket,
  parseCsv,
  parsePriceBuckets,
  SortOption,
} from './search.utils';

export type SearchQuery = {
  city?: string;
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  guests?: number;
  rooms?: number;
  areas?: string;
  priceBuckets?: string;
  minRating?: number;
  propertyTypes?: string;
  businessHotels?: boolean;
  sortBy?: SortOption;
  areaQuery?: string;
};

type AvailabilityResult = {
  minTotalPrice: number | null;
  availableRoomTypeCount: number;
  available: boolean;
};

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly pricing: PricingService,
  ) {}

  async listAreas(cityName: string, query?: string) {
    const city = await this.prisma.city.findFirst({
      where: { name: { equals: cityName, mode: 'insensitive' } },
      include: {
        areas: {
          where: query
            ? { name: { contains: query, mode: 'insensitive' } }
            : undefined,
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!city)
      return {
        city: cityName,
        areas: [] as { id: string; name: string; slug: string }[],
      };
    return {
      city: city.name,
      areas: city.areas.map((a) => ({ id: a.id, name: a.name, slug: a.slug })),
    };
  }

  async listPropertyTypes() {
    return this.prisma.propertyType.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true },
    });
  }

  async getPropertyBySlug(slug: string, query: SearchQuery) {
    const roomsNeeded = query.rooms ?? 1;
    const guestCount =
      query.guests ?? (query.adults ?? 2) + (query.children ?? 0);
    const nights =
      query.checkIn && query.checkOut
        ? eachNight(query.checkIn, query.checkOut)
        : [];

    const property = await this.prisma.property.findFirst({
      where: { slug, status: PropertyStatus.ACTIVE },
      include: {
        propertyType: true,
        area: true,
        addresses: true,
        images: { orderBy: { sortOrder: 'asc' } },
        amenities: {
          include: { amenity: true },
          orderBy: { amenity: { name: 'asc' } },
        },
        policies: { orderBy: { title: 'asc' } },
        tags: { include: { tag: true } },
        roomTypes: {
          where: { status: 'ACTIVE' },
          include: {
            images: { orderBy: { sortOrder: 'asc' } },
            amenities: { include: { amenity: true } },
            inventory: nights.length
              ? { where: { date: { in: nights } } }
              : false,
            ratePlans: {
              where: { status: 'ACTIVE' },
              include: {
                mealPlan: true,
                cancellationPolicy: true,
                prices: nights.length
                  ? { where: { date: { in: nights } } }
                  : false,
              },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!property) {
      throw new NotFoundException('Property not found');
    }

    const address = property.addresses[0];
    const nightsCount = nights.length || 1;
    const imageUrls = await this.s3.toDisplayUrls(
      property.images.map((img) => img.url),
    );

    const roomTypes = (
      await Promise.all(
        property.roomTypes.map(async (roomType) => {
          const availability = this.computeRoomTypeAvailability(
            roomType,
            nights,
            guestCount,
            roomsNeeded,
          );
          if (nights.length && !availability.available) return null;

          const roomImageUrls = await this.s3.toDisplayUrls(
            roomType.images.map((img) => img.url),
          );

          const ratePlans = roomType.ratePlans
            .map((plan) => {
              if (!nights.length) {
                return {
                  id: plan.id,
                  name: plan.name,
                  description: plan.description,
                  mealPlan: plan.mealPlan
                    ? { code: plan.mealPlan.code, name: plan.mealPlan.name }
                    : null,
                  cancellationPolicy: plan.cancellationPolicy
                    ? {
                        name: plan.cancellationPolicy.name,
                        description: plan.cancellationPolicy.description,
                      }
                    : null,
                  totalPrice: null as number | null,
                  pricePerNight: null as number | null,
                  estimatedTaxes: null as number | null,
                  currency: 'INR' as const,
                };
              }

              const prices = this.pricing.matchNights(plan.prices, nights);
              if (!prices) return null;

              const quote = this.pricing.computeQuote(prices, 1);
              const totalPrice = quote.subtotal;

              return {
                id: plan.id,
                name: plan.name,
                description: plan.description,
                mealPlan: plan.mealPlan
                  ? { code: plan.mealPlan.code, name: plan.mealPlan.name }
                  : null,
                cancellationPolicy: plan.cancellationPolicy
                  ? {
                      name: plan.cancellationPolicy.name,
                      description: plan.cancellationPolicy.description,
                    }
                  : null,
                totalPrice,
                pricePerNight: Math.round(totalPrice / nightsCount),
                estimatedTaxes: quote.taxAmount,
                currency: 'INR' as const,
              };
            })
            .filter((plan): plan is NonNullable<typeof plan> => plan !== null);

          if (nights.length && ratePlans.length === 0) return null;

          return {
            id: roomType.id,
            name: roomType.name,
            description: roomType.description,
            maxAdults: roomType.maxAdults,
            maxChildren: roomType.maxChildren,
            maxOccupancy: roomType.maxOccupancy,
            bedType: roomType.bedType,
            sizeSqm: roomType.sizeSqm ? Number(roomType.sizeSqm) : null,
            imageUrls: roomImageUrls,
            amenities: roomType.amenities.map((a) => a.amenity.name),
            ratePlans,
            minPricePerNight:
              ratePlans.length > 0
                ? Math.min(
                    ...ratePlans
                      .map((p) => p.pricePerNight)
                      .filter((p): p is number => p !== null),
                  )
                : null,
          };
        }),
      )
    ).filter((room): room is NonNullable<typeof room> => room !== null);

    const allMinPrices = roomTypes
      .map((rt) => rt.minPricePerNight)
      .filter((p): p is number => p !== null);
    const minPricePerNight =
      allMinPrices.length > 0 ? Math.min(...allMinPrices) : null;
    const minTotalPrice =
      minPricePerNight !== null ? minPricePerNight * nightsCount : null;

    return {
      id: property.id,
      name: property.name,
      slug: property.slug,
      description: property.description,
      starRating: property.starRating,
      guestRating: property.guestRating ? Number(property.guestRating) : null,
      isBusinessHotel: property.isBusinessHotel,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      propertyType: property.propertyType,
      city: address?.city,
      area: property.area?.name ?? address?.city,
      state: address?.state,
      country: address?.country,
      address: address
        ? {
            addressLine1: address.addressLine1,
            addressLine2: address.addressLine2,
            city: address.city,
            state: address.state,
            country: address.country,
            postalCode: address.postalCode,
            latitude: address.latitude ? Number(address.latitude) : null,
            longitude: address.longitude ? Number(address.longitude) : null,
          }
        : null,
      imageUrls,
      tags: property.tags.map((t) => ({
        code: t.tag.code,
        name: t.tag.name,
      })),
      amenities: property.amenities.map((a) => ({
        id: a.amenity.id,
        name: a.amenity.name,
        category: a.amenity.category,
      })),
      policies: property.policies.map((p) => ({
        id: p.id,
        policyType: p.policyType,
        title: p.title,
        description: p.description,
      })),
      roomTypes,
      minTotalPrice,
      minPricePerNight,
      estimatedTaxes:
        minTotalPrice !== null
          ? this.pricing.estimateTaxes(minTotalPrice)
          : null,
      currency: 'INR',
      nights: nightsCount,
    };
  }

  private computeRoomTypeAvailability(
    roomType: Prisma.RoomTypeGetPayload<{
      include: {
        inventory: true;
        ratePlans: { include: { prices: true } };
      };
    }>,
    nights: Date[],
    guestCount: number,
    roomsNeeded: number,
  ) {
    const minOccupancy = Math.ceil(guestCount / roomsNeeded);
    if (roomType.maxOccupancy < minOccupancy) {
      return { available: false };
    }

    if (!nights.length) {
      return { available: roomType.ratePlans.length > 0 };
    }

    const inventoryOk = nights.every((night) => {
      const row = roomType.inventory.find(
        (inv) => inv.date.getTime() === night.getTime(),
      );
      if (!row) return false;
      const free = row.totalRooms - row.blockedRooms - row.soldRooms;
      return free >= roomsNeeded;
    });

    if (!inventoryOk) return { available: false };

    const hasPricing = roomType.ratePlans.some((plan) =>
      nights.every((night) =>
        plan.prices.some((p) => p.date.getTime() === night.getTime()),
      ),
    );

    return { available: hasPricing };
  }

  async searchProperties(query: SearchQuery) {
    const roomsNeeded = query.rooms ?? 1;
    const guestCount =
      query.guests ?? (query.adults ?? 2) + (query.children ?? 0);
    const nights =
      query.checkIn && query.checkOut
        ? eachNight(query.checkIn, query.checkOut)
        : [];

    const areaIds = parseCsv(query.areas);
    const priceBucketIds = parsePriceBuckets(query.priceBuckets);
    const propertyTypeIds = parseCsv(query.propertyTypes);

    const properties = await this.prisma.property.findMany({
      where: {
        status: PropertyStatus.ACTIVE,
        ...(query.businessHotels ? { isBusinessHotel: true } : {}),
        ...(query.minRating ? { guestRating: { gte: query.minRating } } : {}),
        ...(propertyTypeIds.length
          ? { propertyTypeId: { in: propertyTypeIds } }
          : {}),
        ...(areaIds.length ? { areaId: { in: areaIds } } : {}),
        ...(query.city
          ? {
              addresses: {
                some: {
                  city: { equals: query.city, mode: 'insensitive' },
                },
              },
            }
          : {}),
      },
      include: {
        propertyType: true,
        area: true,
        addresses: true,
        images: { orderBy: { sortOrder: 'asc' }, take: 5 },
        amenities: {
          include: { amenity: true },
          take: 20,
        },
        tags: { include: { tag: true } },
        roomTypes: {
          where: { status: 'ACTIVE' },
          include: {
            inventory: nights.length
              ? { where: { date: { in: nights } } }
              : false,
            ratePlans: {
              where: { status: 'ACTIVE' },
              include: {
                prices: nights.length
                  ? { where: { date: { in: nights } } }
                  : false,
              },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    let results = (
      await Promise.all(
        properties.map(async (property) => {
          const availability = this.computeAvailability(
            property.roomTypes,
            nights,
            guestCount,
            roomsNeeded,
          );

          if (nights.length && !availability.available) return [];

          const address = property.addresses[0];
          const minTotalPrice = availability.minTotalPrice;
          const nightsCount = nights.length || 1;
          const minPricePerNight =
            minTotalPrice !== null
              ? Math.round(minTotalPrice / nightsCount)
              : null;

          const imageUrls = await this.s3.toDisplayUrls(
            property.images.map((img) => img.url),
          );

          return [
            {
              id: property.id,
              name: property.name,
              slug: property.slug,
              description: property.description,
              starRating: property.starRating,
              guestRating: property.guestRating
                ? Number(property.guestRating)
                : null,
              isBusinessHotel: property.isBusinessHotel,
              propertyType: property.propertyType,
              city: address?.city,
              area: property.area?.name ?? address?.city,
              state: address?.state,
              country: address?.country,
              imageUrls,
              tags: property.tags.map((t) => ({
                code: t.tag.code,
                name: t.tag.name,
              })),
              amenities: property.amenities.map((a) => a.amenity.name),
              minTotalPrice,
              minPricePerNight,
              estimatedTaxes:
                minTotalPrice !== null
                  ? this.pricing.estimateTaxes(minTotalPrice)
                  : null,
              currency: 'INR',
              nights: nights.length,
              availableRoomTypeCount: availability.availableRoomTypeCount,
              hasSingleRoomType: availability.availableRoomTypeCount === 1,
            },
          ];
        }),
      )
    ).flat();

    if (priceBucketIds.length) {
      results = results.filter((r) =>
        matchesPriceBucket(r.minPricePerNight, priceBucketIds),
      );
    }

    results = this.sortResults(results, query.sortBy ?? 'recommended');

    return { results, count: results.length };
  }

  private computeAvailability(
    roomTypes: Array<
      Prisma.RoomTypeGetPayload<{
        include: {
          inventory: true;
          ratePlans: { include: { prices: true } };
        };
      }>
    >,
    nights: Date[],
    guestCount: number,
    roomsNeeded: number,
  ): AvailabilityResult {
    if (!nights.length) {
      return {
        minTotalPrice: null,
        availableRoomTypeCount: roomTypes.length,
        available: roomTypes.length > 0,
      };
    }

    const minOccupancy = Math.ceil(guestCount / roomsNeeded);
    let bestPrice: number | null = null;
    let availableRoomTypeCount = 0;

    for (const roomType of roomTypes) {
      if (roomType.maxOccupancy < minOccupancy) continue;

      const inventoryOk = nights.every((night) => {
        const row = roomType.inventory.find(
          (inv) => inv.date.getTime() === night.getTime(),
        );
        if (!row) return false;
        const free = row.totalRooms - row.blockedRooms - row.soldRooms;
        return free >= roomsNeeded;
      });
      if (!inventoryOk) continue;

      let roomTypeBest: number | null = null;
      for (const plan of roomType.ratePlans) {
        const prices = this.pricing.matchNights(plan.prices, nights);
        if (!prices) continue;
        const total = this.pricing.computeQuote(prices, 1).subtotal;
        if (roomTypeBest === null || total < roomTypeBest) {
          roomTypeBest = total;
        }
      }

      if (roomTypeBest !== null) {
        availableRoomTypeCount += 1;
        if (bestPrice === null || roomTypeBest < bestPrice) {
          bestPrice = roomTypeBest;
        }
      }
    }

    return {
      minTotalPrice: bestPrice,
      availableRoomTypeCount,
      available: availableRoomTypeCount > 0,
    };
  }

  private sortResults<
    T extends {
      minPricePerNight: number | null;
      guestRating: number | null;
      name: string;
    },
  >(results: T[], sortBy: SortOption): T[] {
    const sorted = [...results];
    switch (sortBy) {
      case 'price_asc':
        sorted.sort(
          (a, b) =>
            (a.minPricePerNight ?? Infinity) - (b.minPricePerNight ?? Infinity),
        );
        break;
      case 'price_desc':
        sorted.sort(
          (a, b) => (b.minPricePerNight ?? -1) - (a.minPricePerNight ?? -1),
        );
        break;
      case 'rating_asc':
        sorted.sort((a, b) => (a.guestRating ?? 0) - (b.guestRating ?? 0));
        break;
      case 'rating_desc':
        sorted.sort((a, b) => (b.guestRating ?? 0) - (a.guestRating ?? 0));
        break;
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }
}
