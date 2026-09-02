import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ReservationStatus } from '../../prisma/client';

export class AdminListBookingsQueryDto {
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
  @IsUUID()
  propertyId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  /** Partial match on reservation number (case-insensitive). */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  checkInFrom?: string;

  @IsOptional()
  @IsString()
  checkInTo?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  refundRequired?: boolean;
}

export class AdminCancelBookingDto {
  @IsOptional()
  @IsString()
  reason?: string;

  /** When true (default), flag captured payments for refund on cancel. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  initiateRefund?: boolean;
}

export class AdminRefundPaymentDto {
  @IsUUID()
  paymentId!: string;

  @IsString()
  reason!: string;

  /** Omit for a full refund of the remaining captured amount. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount?: number;
}

export class UpdateAdminBookingDto {
  @IsOptional()
  @IsString()
  guestFirstName?: string;

  @IsOptional()
  @IsString()
  guestLastName?: string;

  @IsOptional()
  @IsString()
  guestPhone?: string;

  @IsOptional()
  @IsString()
  guestEmail?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  gstin?: string;

  @IsOptional()
  @IsString()
  billingAddress?: string;
}
