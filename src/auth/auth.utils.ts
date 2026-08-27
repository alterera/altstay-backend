import { createHash, randomBytes } from 'crypto';

/** National subscriber number length for supported dial codes. */
const NATIONAL_LENGTH_BY_DIAL: Record<string, number> = {
  '91': 10, // India
};

function resolveDialCode(countryCode?: string): string {
  const dial = (countryCode ?? '+91').replace(/\D/g, '');
  return dial || '91';
}

function nationalLengthForDial(dial: string): number {
  return NATIONAL_LENGTH_BY_DIAL[dial] ?? 10;
}

/**
 * Normalize a phone number to canonical E.164.
 * Accepts national numbers with an optional countryCode, or E.164 input.
 *
 * Indian numbers that start with 91 (e.g. 9101795134) are treated as 10-digit
 * national numbers, not as already including the +91 country code.
 */
export function normalizePhone(
  phone: string,
  countryCode = '+91',
): string {
  const dial = resolveDialCode(countryCode);
  const nationalLength = nationalLengthForDial(dial);
  let digits = phone.replace(/\D/g, '');

  // Strip a single leading trunk zero (e.g. 09101795134 → 9101795134).
  if (digits.startsWith('0') && digits.length === nationalLength + 1) {
    digits = digits.slice(1);
  }

  // National subscriber number (e.g. 9101795134 with country +91).
  if (digits.length === nationalLength) {
    return `+${dial}${digits}`;
  }

  // Full international without "+" (e.g. 919101795134).
  if (
    digits.startsWith(dial) &&
    digits.length === dial.length + nationalLength
  ) {
    return `+${digits}`;
  }

  // Explicit E.164 input.
  if (phone.trim().startsWith('+') && digits.length >= dial.length + 8) {
    return `+${digits}`;
  }

  if (!digits.startsWith(dial)) {
    return `+${dial}${digits}`;
  }

  return `+${digits}`;
}

/** E.164 (+919876543210) → digits only for SMS/WhatsApp gateways. */
export function toGatewayPhoneNumber(e164Phone: string): string {
  return normalizePhone(e164Phone).replace(/\D/g, '');
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

/** Short unique referral code for new accounts. */
export function generateReferralCode(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 8).toUpperCase();
  const suffix = randomBytes(2).toString('hex').toUpperCase();
  return `${hash}${suffix}`;
}
