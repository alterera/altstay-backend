import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PropertyStatus } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { uniqueSlug } from '../../common/utils/slug.util';
import { S3Service } from '../uploads/s3.service';
import { DEFAULT_ORG_ID } from '../admin.utils';
import {
  CreatePropertyDto,
  UpdatePropertyAmenitiesDto,
  UpdatePropertyDto,
  UpdatePropertyPoliciesDto,
  UpdatePropertyStatusDto,
} from '../dto/admin.dto';

const propertyInclude = {
  propertyType: true,
  area: true,
  addresses: true,
  amenities: { include: { amenity: true } },
  tags: { include: { tag: true } },
  images: { orderBy: { sortOrder: 'asc' as const } },
  policies: true,
  organization: true,
} satisfies Prisma.PropertyInclude;

@Injectable()
export class AdminPropertiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  async list() {
    const properties = await this.prisma.property.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        starRating: true,
        updatedAt: true,
        propertyType: { select: { id: true, code: true, name: true, description: true } },
        addresses: {
          take: 1,
          select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            country: true,
            postalCode: true,
            latitude: true,
            longitude: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return properties;
  }

  async getById(id: string) {
    const property = await this.prisma.property.findUnique({
      where: { id },
      include: propertyInclude,
    });
    if (!property) throw new NotFoundException('Property not found');
    return this.withSignedImages(property);
  }

  async create(dto: CreatePropertyDto) {
    const org = await this.prisma.organization.findUnique({
      where: { id: DEFAULT_ORG_ID },
    });
    if (!org) {
      throw new BadRequestException('Default organization not seeded');
    }

    const slug = await uniqueSlug(dto.name, async (candidate) => {
      const existing = await this.prisma.property.findUnique({
        where: { slug: candidate },
      });
      return Boolean(existing);
    });

    const property = await this.prisma.property.create({
      data: {
        organizationId: org.id,
        propertyTypeId: dto.propertyTypeId,
        areaId: dto.areaId,
        name: dto.name,
        slug,
        description: dto.description,
        starRating: dto.starRating,
        guestRating: dto.guestRating,
        isBusinessHotel: dto.isBusinessHotel ?? false,
        checkInTime: dto.checkInTime,
        checkOutTime: dto.checkOutTime,
        status: PropertyStatus.DRAFT,
        addresses: {
          create: {
            addressLine1: dto.address.addressLine1,
            addressLine2: dto.address.addressLine2,
            city: dto.address.city,
            state: dto.address.state,
            country: dto.address.country,
            postalCode: dto.address.postalCode,
            latitude: dto.address.latitude,
            longitude: dto.address.longitude,
          },
        },
        ...(dto.amenityIds?.length
          ? {
              amenities: {
                create: dto.amenityIds.map((amenityId) => ({ amenityId })),
              },
            }
          : {}),
        ...(dto.tagIds?.length
          ? {
              tags: {
                create: dto.tagIds.map((tagId) => ({ tagId })),
              },
            }
          : {}),
      },
      include: propertyInclude,
    });

    return property;
  }

  async update(id: string, dto: UpdatePropertyDto) {
    await this.assertExists(id);

    const data: Prisma.PropertyUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.propertyTypeId !== undefined) {
      data.propertyType = { connect: { id: dto.propertyTypeId } };
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.starRating !== undefined) data.starRating = dto.starRating;
    if (dto.checkInTime !== undefined) data.checkInTime = dto.checkInTime;
    if (dto.checkOutTime !== undefined) data.checkOutTime = dto.checkOutTime;
    if (dto.guestRating !== undefined) data.guestRating = dto.guestRating;
    if (dto.isBusinessHotel !== undefined) {
      data.isBusinessHotel = dto.isBusinessHotel;
    }
    if (dto.areaId !== undefined) {
      data.area = dto.areaId
        ? { connect: { id: dto.areaId } }
        : { disconnect: true };
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    if (Object.keys(data).length) {
      ops.push(this.prisma.property.update({ where: { id }, data }));
    }

    if (dto.tagIds !== undefined) {
      ops.push(
        this.prisma.propertyTagAssignment.deleteMany({
          where: { propertyId: id },
        }),
      );
      if (dto.tagIds.length) {
        ops.push(
          this.prisma.propertyTagAssignment.createMany({
            data: dto.tagIds.map((tagId) => ({ propertyId: id, tagId })),
          }),
        );
      }
    }

    if (dto.address) {
      const existing = await this.prisma.propertyAddress.findFirst({
        where: { propertyId: id },
      });
      const addressData = {
        addressLine1: dto.address.addressLine1,
        addressLine2: dto.address.addressLine2,
        city: dto.address.city,
        state: dto.address.state,
        country: dto.address.country,
        postalCode: dto.address.postalCode,
        latitude: dto.address.latitude,
        longitude: dto.address.longitude,
      };
      if (existing) {
        ops.push(
          this.prisma.propertyAddress.update({
            where: { id: existing.id },
            data: addressData,
          }),
        );
      } else {
        ops.push(
          this.prisma.propertyAddress.create({
            data: { propertyId: id, ...addressData },
          }),
        );
      }
    }

    if (ops.length) {
      await this.prisma.$transaction(ops);
    }

    return this.getById(id);
  }

  async updateStatus(id: string, dto: UpdatePropertyStatusDto) {
    await this.assertExists(id);
    const property = await this.prisma.property.update({
      where: { id },
      data: { status: dto.status },
      include: propertyInclude,
    });
    return this.withSignedImages(property);
  }

  async replaceAmenities(id: string, dto: UpdatePropertyAmenitiesDto) {
    await this.assertExists(id);
    await this.prisma.$transaction([
      this.prisma.propertyAmenity.deleteMany({ where: { propertyId: id } }),
      this.prisma.propertyAmenity.createMany({
        data: dto.amenityIds.map((amenityId) => ({
          propertyId: id,
          amenityId,
        })),
      }),
    ]);
    return this.getById(id);
  }

  async replacePolicies(id: string, dto: UpdatePropertyPoliciesDto) {
    await this.assertExists(id);
    await this.prisma.$transaction([
      this.prisma.propertyPolicy.deleteMany({ where: { propertyId: id } }),
      this.prisma.propertyPolicy.createMany({
        data: dto.policies.map((policy) => ({
          propertyId: id,
          policyType: policy.policyType,
          title: policy.title,
          description: policy.description,
        })),
      }),
    ]);
    return this.getById(id);
  }

  async addImage(
    propertyId: string,
    file: Express.Multer.File,
    type = 'PROPERTY',
  ) {
    await this.assertExists(propertyId);
    const url = await this.s3.uploadPropertyImage(propertyId, file);
    const count = await this.prisma.propertyImage.count({
      where: { propertyId },
    });
    const image = await this.prisma.propertyImage.create({
      data: {
        propertyId,
        url,
        type,
        sortOrder: count,
      },
    });
    return { ...image, url: await this.s3.toDisplayUrl(image.url) };
  }

  private async assertExists(id: string): Promise<void> {
    const row = await this.prisma.property.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Property not found');
  }

  private async withSignedImages<T extends { images: { url: string }[] }>(
    property: T,
  ): Promise<T> {
    const images = await Promise.all(
      property.images.map(async (image) => ({
        ...image,
        url: await this.s3.toDisplayUrl(image.url),
      })),
    );
    return { ...property, images };
  }

  async deleteImage(propertyId: string, imageId: string) {
    const image = await this.prisma.propertyImage.findFirst({
      where: { id: imageId, propertyId },
    });
    if (!image) throw new NotFoundException('Image not found');
    await this.s3.deleteByUrl(image.url).catch(() => undefined);
    await this.prisma.propertyImage.delete({ where: { id: imageId } });
    return { success: true };
  }
}
