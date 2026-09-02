import {
  addDays,
  calculateRenewalExpiry,
  calculateUpgradeExpiry,
  daysBetween,
  planDailyRate,
} from './membership.utils';

describe('membership.utils', () => {
  const individualPlan = {
    code: 'INDIVIDUAL',
    price: 1,
    durationDays: 365,
  };
  const corporatePlan = {
    code: 'CORPORATE',
    price: 2599,
    durationDays: 365,
  };

  it('computes plan daily rates', () => {
    expect(planDailyRate(individualPlan)).toBeCloseTo(999 / 365, 2);
    expect(planDailyRate(corporatePlan)).toBeCloseTo(2599 / 365, 2);
  });

  it('converts remaining Individual value into Corporate bonus days on upgrade', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const currentExpiresAt = addDays(now, 300);

    const result = calculateUpgradeExpiry(now, corporatePlan, {
      expiresAt: currentExpiresAt,
      plan: individualPlan,
    });

    const remainingValue = 300 * planDailyRate(individualPlan);
    const bonusDays = Math.floor(
      remainingValue / planDailyRate(corporatePlan),
    );

    expect(result.upgradeCreditDays).toBe(bonusDays);
    expect(result.upgradeCreditDays).toBeGreaterThan(100);
    expect(daysBetween(now, result.expiresAt)).toBe(365 + bonusDays);
  });

  it('renews from remaining expiry for same-plan purchase', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const currentExpiresAt = new Date('2026-09-01T00:00:00.000Z');

    const renewed = calculateRenewalExpiry(now, individualPlan, currentExpiresAt);
    expect(daysBetween(currentExpiresAt, renewed)).toBe(365);
  });
});
