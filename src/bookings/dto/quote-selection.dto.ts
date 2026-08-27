import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Shared selection params for quote and intent endpoints. */
export class QuoteSelectionDto {
  @IsString()
  @IsNotEmpty()
  propertySlug!: string;

  @IsUUID()
  roomTypeId!: string;

  @IsUUID()
  ratePlanId!: string;

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
}
