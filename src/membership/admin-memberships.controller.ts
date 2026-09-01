import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminMembershipsService } from './admin-memberships.service';
import {
  AdminRefundMembershipDto,
  AdminUpdateMembershipDto,
} from './dto/membership.dto';

@Controller('admin/memberships')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'FINANCE')
export class AdminMembershipsController {
  constructor(private readonly admin: AdminMembershipsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.admin.list({
      status,
      userId,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: AdminUpdateMembershipDto) {
    return this.admin.updateMembership(id, dto);
  }

  @Post('purchases/:id/refund')
  refund(@Param('id') id: string, @Body() dto: AdminRefundMembershipDto) {
    return this.admin.refundPurchase(id, dto.reason);
  }
}
