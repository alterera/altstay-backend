import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAmenityDto } from '../dto/admin.dto';

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
}
