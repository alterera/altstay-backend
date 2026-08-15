import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { OtpChannel } from '../../prisma/client';

export class RequestOtpDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 or national number',
  })
  phone!: string;

  /** Optional country dial code used when phone is national-only (e.g. "91" or "+91"). */
  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsOptional()
  @IsEnum(OtpChannel)
  channel?: OtpChannel;

  @IsOptional()
  @IsBoolean()
  sendWhatsappOtp?: boolean;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 or national number',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'otp must be 4–8 digits' })
  otp!: string;
}

export class PasswordLoginDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid E.164 or national number',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}
