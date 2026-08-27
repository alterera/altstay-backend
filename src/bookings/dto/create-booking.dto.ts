import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class BookingGuestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

/**
 * All three fields are required together. A GSTIN without a company name is not
 * a usable tax invoice, so the DTO makes the whole block mandatory once present.
 */
export class BusinessBookingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  companyName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  gstin!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  billingAddress!: string;
}

export class CreateBookingDto {
  @IsString()
  @IsNotEmpty()
  propertySlug!: string;

  @IsUUID()
  roomTypeId!: string;

  @IsUUID()
  ratePlanId!: string;

  /** yyyy-MM-dd, interpreted as a UTC calendar date. */
  @IsISO8601({ strict: true })
  checkIn!: string;

  @IsISO8601({ strict: true })
  checkOut!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  rooms!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  adults!: number;

  @ValidateNested()
  @Type(() => BookingGuestDto)
  guest!: BookingGuestDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BusinessBookingDto)
  businessBooking?: BusinessBookingDto;

  @IsString()
  @IsNotEmpty()
  quoteToken!: string;
}
