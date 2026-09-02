import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PropertyStatus } from '../../prisma/client';

export class AddressDto {
  @IsString()
  addressLine1!: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsString()
  city!: string;

  @IsString()
  state!: string;

  @IsString()
  country!: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}

export class CreatePropertyDto {
  @IsString()
  name!: string;

  @IsUUID()
  propertyTypeId!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  starRating?: number;

  @IsOptional()
  @IsString()
  checkInTime?: string;

  @IsOptional()
  @IsString()
  checkOutTime?: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  amenityIds?: string[];

  @IsOptional()
  @IsUUID()
  areaId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  guestRating?: number;

  @IsOptional()
  @IsBoolean()
  isBusinessHotel?: boolean;
}

export class UpdatePropertyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUUID()
  propertyTypeId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  starRating?: number;

  @IsOptional()
  @IsString()
  checkInTime?: string;

  @IsOptional()
  @IsString()
  checkOutTime?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @IsOptional()
  @IsUUID()
  areaId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  guestRating?: number;

  @IsOptional()
  @IsBoolean()
  isBusinessHotel?: boolean;
}

export class UpdatePropertyStatusDto {
  @IsEnum(PropertyStatus)
  status!: PropertyStatus;
}

export class UpdatePropertyAmenitiesDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  amenityIds!: string[];
}

export class PropertyPolicyDto {
  @IsString()
  policyType!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdatePropertyPoliciesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PropertyPolicyDto)
  policies!: PropertyPolicyDto[];
}

export class CreateAmenityDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

export class CreateCityDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;
}

export class UpdateCityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;
}

export class CreateAreaDto {
  @IsString()
  name!: string;
}

export class UpdateAreaDto {
  @IsOptional()
  @IsString()
  name?: string;
}


export class CreateRoomTypeDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  maxAdults!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxChildren?: number;

  @IsInt()
  @Min(1)
  maxOccupancy!: number;

  @IsOptional()
  @IsString()
  bedType?: string;

  @IsOptional()
  @IsNumber()
  sizeSqm?: number;
}

export class UpdateRoomTypeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdults?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxChildren?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOccupancy?: number;

  @IsOptional()
  @IsString()
  bedType?: string;

  @IsOptional()
  @IsNumber()
  sizeSqm?: number;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;
}

export class UpdateInventoryRowDto {
  @IsInt()
  @Min(0)
  totalRooms!: number;

  @IsInt()
  @Min(0)
  blockedRooms!: number;
}

export class CreateRoomDto {
  @IsUUID()
  roomTypeId!: string;

  @IsString()
  roomNumber!: string;

  @IsOptional()
  @IsString()
  floor?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class UpsertInventoryDto {
  @IsUUID()
  roomTypeId!: string;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsInt()
  @Min(0)
  totalRooms!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  blockedRooms?: number;
}

export class CreateRatePlanDto {
  @IsUUID()
  roomTypeId!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  mealPlanId?: string;

  @IsOptional()
  @IsUUID()
  cancellationPolicyId?: string;
}

export class UpsertRatePricesDto {
  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsNumber()
  @Min(0)
  basePrice!: number;

  @IsOptional()
  @IsString()
  currency?: string;
}

export class UpdateRatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  mealPlanId?: string;

  @IsOptional()
  @IsUUID()
  cancellationPolicyId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;
}
