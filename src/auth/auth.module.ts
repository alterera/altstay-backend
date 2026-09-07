import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { SavedGuestsController } from './saved-guests.controller';
import { SavedGuestsService } from './saved-guests.service';
import { WhatsappOtpService } from './whatsapp-otp.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES_IN') ??
            '15m') as `${number}${'s' | 'm' | 'h' | 'd'}`,
        },
      }),
    }),
  ],
  controllers: [AuthController, SavedGuestsController],
  providers: [
    AuthService,
    JwtStrategy,
    RateLimitService,
    WhatsappOtpService,
    SavedGuestsService,
  ],
  // RateLimitService is exported so other modules throttle against the same
  // buckets rather than each holding a private counter.
  exports: [AuthService, RateLimitService],
})
export class AuthModule {}
