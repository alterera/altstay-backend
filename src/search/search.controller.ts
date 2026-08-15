import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SearchService, type SearchQuery } from './search.service';

class SearchPropertiesQueryDto implements SearchQuery {
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  checkIn?: string;

  @IsOptional()
  @IsString()
  checkOut?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  adults?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  children?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  guests?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rooms?: number;

  @IsOptional()
  @IsString()
  areas?: string;

  @IsOptional()
  @IsString()
  priceBuckets?: string;

  @IsOptional()
  @Type(() => Number)
  minRating?: number;

  @IsOptional()
  @IsString()
  propertyTypes?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  businessHotels?: boolean;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'rating_asc', 'rating_desc', 'recommended'])
  sortBy?: SearchQuery['sortBy'];
}

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('properties')
  searchProperties(@Query() query: SearchPropertiesQueryDto) {
    return this.search.searchProperties(query);
  }

  @Get('areas')
  listAreas(
    @Query('city') city: string,
    @Query('q') q?: string,
  ) {
    return this.search.listAreas(city, q);
  }

  @Get('property-types')
  listPropertyTypes() {
    return this.search.listPropertyTypes();
  }
}
