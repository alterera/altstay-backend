import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReviewStatus } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateReviewStatusDto } from '../dto/admin.dto';

@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminReviewsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('propertyId') propertyId?: string) {
    return this.prisma.review.findMany({
      where: propertyId ? { propertyId } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { firstName: true, lastName: true, phone: true } },
        property: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateReviewStatusDto) {
    return this.prisma.review.update({
      where: { id },
      data: { status: dto.status as ReviewStatus },
    });
  }
}
