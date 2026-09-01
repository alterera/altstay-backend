import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  LoginMethod,
  OtpChannel,
  OtpPurpose,
  User,
  UserStatus,
} from '../prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  PasswordLoginDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { UpdatePasswordDto, UpdateProfileDto } from './dto/profile.dto';
import {
  generateOtp,
  generateReferralCode,
  hashToken,
  normalizePhone,
  parseExpiry,
} from './auth.utils';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { WhatsappOtpService } from './whatsapp-otp.service';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
};

type AuthUserView = {
  id: string;
  phone: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  status: UserStatus;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly rateLimit: RateLimitService,
    private readonly whatsappOtp: WhatsappOtpService,
  ) {}

  async requestOtp(
    dto: RequestOtpDto,
    meta: { ip?: string; userAgent?: string },
  ) {
    const phone = normalizePhone(dto.phone, dto.countryCode);
    this.rateLimit.consume(`otp:phone:${phone}`, 5, 15 * 60 * 1000);
    if (meta.ip) {
      this.rateLimit.consume(`otp:ip:${meta.ip}`, 20, 60 * 60 * 1000);
    }

    const channel = OtpChannel.WHATSAPP;

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });
    const purpose = existingUser
      ? OtpPurpose.LOGIN
      : OtpPurpose.REGISTRATION;

    const otp = generateOtp(6);
    const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);

    await this.prisma.otpVerification.create({
      data: {
        userId: existingUser?.id ?? null,
        identifier: phone,
        purpose,
        channel,
        otpHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    try {
      await this.whatsappOtp.sendOtp(phone, otp);
    } catch (error) {
      this.logger.error(`WhatsApp OTP delivery failed for ${phone}`);
      throw error;
    }

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(
        `\n${'='.repeat(48)}\nDEV LOGIN OTP (also sent via WhatsApp when configured)\nPhone: ${phone}\nCode:  ${otp}\nExpires in ${OTP_TTL_MS / 1000}s\n${'='.repeat(48)}\n`,
      );
    }

    return {
      success: true,
      purpose,
      channel,
      expiresInSeconds: OTP_TTL_MS / 1000,
      // Dev-only helper so the frontend can be tested without SMS/WhatsApp.
      ...(process.env.NODE_ENV !== 'production' ? { debugOtp: otp } : {}),
    };
  }

  async verifyOtp(
    dto: VerifyOtpDto,
    meta: { ip?: string; userAgent?: string },
  ) {
    const phone = normalizePhone(dto.phone, dto.countryCode);

    const record = await this.prisma.otpVerification.findFirst({
      where: {
        identifier: phone,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      await this.recordLogin(null, phone, LoginMethod.OTP, false, meta, 'OTP_NOT_FOUND');
      throw new UnauthorizedException('OTP expired or not found');
    }

    if (record.attemptCount >= OTP_MAX_ATTEMPTS) {
      await this.recordLogin(
        record.userId,
        phone,
        LoginMethod.OTP,
        false,
        meta,
        'OTP_MAX_ATTEMPTS',
      );
      throw new UnauthorizedException('Too many OTP attempts');
    }

    const valid = await bcrypt.compare(dto.otp, record.otpHash);
    if (!valid) {
      await this.prisma.otpVerification.update({
        where: { id: record.id },
        data: { attemptCount: { increment: 1 } },
      });
      await this.recordLogin(
        record.userId,
        phone,
        LoginMethod.OTP,
        false,
        meta,
        'OTP_INVALID',
      );
      throw new UnauthorizedException('Invalid OTP');
    }

    const verifiedAt = new Date();
    await this.prisma.otpVerification.update({
      where: { id: record.id },
      data: { verifiedAt },
    });

    const customerRole = await this.prisma.role.findUnique({
      where: { name: 'CUSTOMER' },
    });
    if (!customerRole) {
      throw new BadRequestException(
        'Platform roles not seeded. Run prisma db seed.',
      );
    }

    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      const referralCode = await this.uniqueReferralCode(phone);

      user = await this.prisma.user.create({
        data: {
          phone,
          status: UserStatus.ACTIVE,
          mobileVerifiedAt: verifiedAt,
          lastLoginAt: verifiedAt,
          referralCode,
          membershipTier: 'Free',
          userRoles: {
            create: { roleId: customerRole.id },
          },
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          status:
            user.status === UserStatus.PENDING_VERIFICATION
              ? UserStatus.ACTIVE
              : user.status,
          mobileVerifiedAt: user.mobileVerifiedAt ?? verifiedAt,
          lastLoginAt: verifiedAt,
          ...(!user.referralCode
            ? { referralCode: await this.uniqueReferralCode(user.id) }
            : {}),
        },
      });
    }

    const tokens = await this.issueTokens(user, meta);

    await this.prisma.otpVerification.update({
      where: { id: record.id },
      data: { consumedAt: new Date(), userId: user.id },
    });

    await this.recordLogin(user.id, phone, LoginMethod.OTP, true, meta);

    return { user: this.toUserView(user), ...tokens };
  }

  async loginWithPassword(
    dto: PasswordLoginDto,
    meta: { ip?: string; userAgent?: string },
    options?: { requireRoles?: string[] },
  ) {
    const phone = normalizePhone(dto.phone, dto.countryCode);
    this.rateLimit.consume(`password:phone:${phone}`, 10, 15 * 60 * 1000);

    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user?.passwordHash) {
      await this.recordLogin(
        user?.id ?? null,
        phone,
        LoginMethod.PASSWORD,
        false,
        meta,
        'INVALID_CREDENTIALS',
      );
      throw new UnauthorizedException('Invalid phone or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      await this.recordLogin(
        user.id,
        phone,
        LoginMethod.PASSWORD,
        false,
        meta,
        'INVALID_CREDENTIALS',
      );
      throw new UnauthorizedException('Invalid phone or password');
    }

    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DELETED) {
      throw new UnauthorizedException('Account is not active');
    }

    if (options?.requireRoles?.length) {
      await this.assertUserRoles(user.id, options.requireRoles);
    }

    const tokens = await this.issueTokens(user, meta);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.recordLogin(user.id, phone, LoginMethod.PASSWORD, true, meta);

    return { user: this.toUserView(user), ...tokens };
  }

  async adminLogin(
    dto: PasswordLoginDto,
    meta: { ip?: string; userAgent?: string },
  ) {
    const result = await this.loginWithPassword(dto, meta, {
      requireRoles: ['SUPER_ADMIN'],
    });
    const me = await this.me(result.user.id);
    return { ...result, user: me };
  }

  private async assertUserRoles(userId: string, requiredRoles: string[]) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    const names = userRoles.map((ur) => ur.role.name);
    const allowed = requiredRoles.some((role) => names.includes(role));
    if (!allowed) {
      throw new ForbiddenException('Admin access required');
    }
  }

  async refresh(refreshToken: string, meta: { ip?: string; userAgent?: string }) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt < new Date() ||
      stored.user.status === UserStatus.DELETED ||
      stored.user.status === UserStatus.SUSPENDED
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotate: revoke old, issue new
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(stored.user, meta);
    await this.prisma.refreshToken.update({
      where: { tokenHash: hashToken(tokens.refreshToken) },
      data: { lastUsedAt: new Date() },
    });

    return { user: this.toUserView(stored.user), ...tokens };
  }

  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        gender: true,
        dateOfBirth: true,
        cityOfResidence: true,
        referralCode: true,
        alterCashBalance: true,
        membershipTier: true,
        membershipExpiresAt: true,
        passwordHash: true,
        userRoles: { include: { role: true } },
      },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    return this.toProfileView(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim() || null;
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim() || null;
    if (dto.email !== undefined) data.email = dto.email.trim() || null;
    if (dto.gender !== undefined) data.gender = dto.gender.trim() || null;
    if (dto.cityOfResidence !== undefined) {
      data.cityOfResidence = dto.cityOfResidence.trim() || null;
    }
    if (dto.dateOfBirth !== undefined) {
      data.dateOfBirth = dto.dateOfBirth
        ? new Date(`${dto.dateOfBirth}T00:00:00.000Z`)
        : null;
    }
    if (dto.password) {
      data.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.me(userId);
  }

  async updatePassword(userId: string, dto: UpdatePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new BadRequestException('Set a password before changing it');
    }

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS),
      },
    });

    return { success: true };
  }

  private async uniqueReferralCode(seed: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateReferralCode(`${seed}:${attempt}:${Date.now()}`);
      const existing = await this.prisma.user.findUnique({
        where: { referralCode: code },
        select: { id: true },
      });
      if (!existing) return code;
    }
    return generateReferralCode(`${seed}:${randomBytes(8).toString('hex')}`);
  }

  private async issueTokens(
    user: User,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const accessExpiresIn =
      this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m';
    const refreshExpiresIn =
      this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d';

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, phone: user.phone },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}`,
      },
    );

    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: parseExpiry(refreshExpiresIn),
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return { accessToken, refreshToken, expiresIn: accessExpiresIn };
  }

  private async recordLogin(
    userId: string | null,
    identifier: string,
    loginMethod: LoginMethod,
    success: boolean,
    meta: { ip?: string; userAgent?: string },
    failureReason?: string,
  ) {
    await this.prisma.loginHistory.create({
      data: {
        userId,
        identifier,
        loginMethod,
        success,
        failureReason,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  }

  private toProfileView(
    user: {
      id: string;
      phone: string;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      status: UserStatus;
      gender: string | null;
      dateOfBirth: Date | null;
      cityOfResidence: string | null;
      referralCode: string | null;
      alterCashBalance: { toString(): string } | number;
      membershipTier: string;
      membershipExpiresAt: Date | null;
      passwordHash: string | null;
      userRoles: { role: { name: string } }[];
    },
  ) {
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth
        ? user.dateOfBirth.toISOString().slice(0, 10)
        : null,
      cityOfResidence: user.cityOfResidence,
      referralCode: user.referralCode,
      alterCashBalance: Number(user.alterCashBalance),
      membershipTier: user.membershipTier,
      membershipExpiresAt: user.membershipExpiresAt?.toISOString() ?? null,
      hasPassword: Boolean(user.passwordHash),
      roles: user.userRoles.map((ur) => ur.role.name),
    };
  }

  private toUserView(user: User): AuthUserView {
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
    };
  }
}
