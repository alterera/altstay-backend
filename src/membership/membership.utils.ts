import { MembershipPlan } from '../prisma/client';
import { MembershipExpiryCalculation } from './membership.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(start: Date, end: Date): number {
  const diff = end.getTime() - start.getTime();
  return Math.max(0, Math.ceil(diff / MS_PER_DAY));
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

export function planDailyRate(plan: Pick<MembershipPlan, 'price' | 'durationDays'>): number {
  return Number(plan.price) / plan.durationDays;
}

/**
 * Option B: convert remaining Individual value into Corporate days, then add
 * full purchased duration from the new plan payment.
 */
export function calculateUpgradeExpiry(
  now: Date,
  newPlan: Pick<MembershipPlan, 'price' | 'durationDays'>,
  currentMembership?: {
    expiresAt: Date;
    plan: Pick<MembershipPlan, 'price' | 'durationDays' | 'code'>;
  } | null,
): MembershipExpiryCalculation {
  const purchasedDays = newPlan.durationDays;
  let bonusDays = 0;
  let upgradeCreditValue: number | null = null;

  if (currentMembership && currentMembership.expiresAt > now) {
    const remainingDays = daysBetween(now, currentMembership.expiresAt);
    const remainingValue = remainingDays * planDailyRate(currentMembership.plan);
    const bonusCorporateDays = Math.floor(
      remainingValue / planDailyRate(newPlan),
    );
    bonusDays = bonusCorporateDays;
    upgradeCreditValue = Math.round(remainingValue * 100) / 100;
  }

  const totalDays = purchasedDays + bonusDays;
  return {
    expiresAt: addDays(now, totalDays),
    upgradeCreditDays: bonusDays > 0 ? bonusDays : null,
    upgradeCreditValue,
  };
}

/** Same-plan renewal extends from max(now, current.expiresAt). */
export function calculateRenewalExpiry(
  now: Date,
  plan: Pick<MembershipPlan, 'durationDays'>,
  currentExpiresAt?: Date | null,
): Date {
  const base = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
  return addDays(base, plan.durationDays);
}

export function isMembershipPaymentReference(reference: string): boolean {
  return reference.startsWith('MEM-');
}
