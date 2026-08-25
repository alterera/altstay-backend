import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { slugify } from '../admin.utils';
import {
  CreateAmenityDto,
  CreateAreaDto,
  CreateCityDto,
  UpdateAreaDto,
  UpdateCityDto,
} from '../dto/admin.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminCatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('cities')
  listCities() {
    return this.prisma.city.findMany({
      orderBy: { name: 'asc' },
      include: { areas: { orderBy: { name: 'asc' } } },
    });
  }

  @Post('cities')
  async createCity(@Body() dto: CreateCityDto) {
    try {
      return await this.prisma.city.create({
        data: {
          name: dto.name.trim(),
          slug: slugify(dto.name),
          state: dto.state?.trim() || null,
          country: dto.country?.trim() || 'India',
        },
        include: { areas: true },
      });
    } catch (error) {
      this.rethrowUnique(error, 'A city with that name already exists');
    }
  }

  @Patch('cities/:id')
  async updateCity(@Param('id') id: string, @Body() dto: UpdateCityDto) {
    const data: Prisma.CityUpdateInput = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      data.slug = slugify(dto.name);
    }
    if (dto.state !== undefined) data.state = dto.state.trim() || null;
    if (dto.country !== undefined) data.country = dto.country.trim() || 'India';
    try {
      return await this.prisma.city.update({
        where: { id },
        data,
        include: { areas: { orderBy: { name: 'asc' } } },
      });
    } catch (error) {
      this.rethrowUnique(error, 'A city with that name already exists');
    }
  }

  @Delete('cities/:id')
  async deleteCity(@Param('id') id: string) {
    await this.prisma.city.delete({ where: { id } });
    return { success: true };
  }

  @Post('cities/:cityId/areas')
  async createArea(
    @Param('cityId') cityId: string,
    @Body() dto: CreateAreaDto,
  ) {
    try {
      return await this.prisma.area.create({
        data: {
          cityId,
          name: dto.name.trim(),
          slug: slugify(dto.name),
        },
      });
    } catch (error) {
      this.rethrowUnique(error, 'That area already exists in this city');
    }
  }

  @Patch('areas/:id')
  async updateArea(@Param('id') id: string, @Body() dto: UpdateAreaDto) {
    try {
      return await this.prisma.area.update({
        where: { id },
        data: dto.name
          ? { name: dto.name.trim(), slug: slugify(dto.name) }
          : {},
      });
    } catch (error) {
      this.rethrowUnique(error, 'That area already exists in this city');
    }
  }

  @Delete('areas/:id')
  async deleteArea(@Param('id') id: string) {
    await this.prisma.area.delete({ where: { id } });
    return { success: true };
  }

  @Get('property-tags')
  listPropertyTags() {
    return this.prisma.propertyTag.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('property-types')
  listPropertyTypes() {
    return this.prisma.propertyType.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('amenities')
  listAmenities() {
    return this.prisma.amenity.findMany({ orderBy: { name: 'asc' } });
  }

  @Post('amenities')
  createAmenity(@Body() dto: CreateAmenityDto) {
    return this.prisma.amenity.create({
      data: {
        name: dto.name,
        category: dto.category,
        icon: dto.icon,
        status: 'ACTIVE',
      },
    });
  }

  @Get('meal-plans')
  listMealPlans() {
    return this.prisma.mealPlan.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('cancellation-policies')
  listCancellationPolicies() {
    return this.prisma.cancellationPolicy.findMany({ orderBy: { name: 'asc' } });
  }

  private rethrowUnique(error: unknown, message: string): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
