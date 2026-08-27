import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ReservationStatus } from '../../prisma/client';
import {
  BOOKING_LIST_TABS,
  type BookingListTab,
} from '../booking-list.filters';

export class ListBookingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;

  @IsOptional()
  @IsIn(BOOKING_LIST_TABS)
  tab?: BookingListTab;
}
