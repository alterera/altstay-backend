import { createHash } from 'crypto';

/**
 * Normalize a phone number to canonical E.164.
 * Accepts national Indian numbers (10 digits) with optional countryCode,
 * or an already-formatted E.164 string.
 */
export function normalizePhone(
  phone: string,
  countryCode = '+91',
): string {
  const digits = phone.replace(/\D/g, '');
  const dial = countryCode.replace(/\D/g, '') || '91';

  if (phone.trim().startsWith('+') && digits.length >= 8) {
    return `+${digits}`;
  }

  // Already includes country dial code (e.g. 919876543210)
  if (digits.startsWith(dial) && digits.length > dial.length + 6) {
    return `+${digits}`;
  }

  // National number
  return `+${dial}${digits}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateOtp(length = 6): string {
  const max = 10 ** length;
  const num = Math.floor(Math.random() * max);
  return num.toString().padStart(length, '0');
}

export function parseExpiry(duration: string, from = new Date()): Date {
  const match = /^(\d+)([smhd])$/i.exec(duration.trim());
  if (!match) {
    // Default 30 days if unparseable
    return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return new Date(from.getTime() + amount * multipliers[unit]);
}
