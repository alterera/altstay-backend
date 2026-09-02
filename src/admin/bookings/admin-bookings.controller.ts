import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  AdminCancelBookingDto,
  AdminListBookingsQueryDto,
  AdminRefundPaymentDto,
  UpdateAdminBookingDto,
} from './admin-bookings.dto';
import { AdminBookingsService } from './admin-bookings.service';

@Controller('admin/bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get()
  list(@Query() query: AdminListBookingsQueryDto) {
    return this.bookings.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.bookings.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAdminBookingDto) {
    return this.bookings.update(id, dto);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string) {
    return this.bookings.accept(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: AdminCancelBookingDto) {
    return this.bookings.cancel(id, dto);
  }

  @Post(':id/refund')
  refund(@Param('id') id: string, @Body() dto: AdminRefundPaymentDto) {
    return this.bookings.refundPayment(id, dto);
  }

  @Post(':id/no-show')
  markNoShow(@Param('id') id: string) {
    return this.bookings.markNoShow(id);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string) {
    return this.bookings.complete(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.bookings.remove(id);
  }
}
