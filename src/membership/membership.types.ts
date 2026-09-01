import { MembershipPlan, UserMembership } from '../prisma/client';

export type ActiveMembership = {
  membership: UserMembership;
  plan: MembershipPlan;
  planCode: string;
  discountPercent: number;
};

export type UpgradePreview = {
  planCode: string;
  planName: string;
  price: number;
  purchasedDays: number;
  bonusDays: number;
  totalDays: number;
  remainingValue: number;
  expiresAt: string;
};

export type MembershipExpiryCalculation = {
  expiresAt: Date;
  upgradeCreditDays: number | null;
  upgradeCreditValue: number | null;
};
