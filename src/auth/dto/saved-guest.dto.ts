import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateSavedGuestDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @Matches(/^\+?[0-9\s-]{8,15}$/)
  phone!: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class UpdateSavedGuestDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9\s-]{8,15}$/)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string | null;
}
