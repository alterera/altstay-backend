import { IsIn, IsString, MaxLength } from 'class-validator';

export const MEMBERSHIP_PLAN_CODES = ['INDIVIDUAL', 'CORPORATE'] as const;
export type MembershipPlanCode = (typeof MEMBERSHIP_PLAN_CODES)[number];

export class CreateMembershipPurchaseDto {
  @IsString()
  @MaxLength(32)
  @IsIn(MEMBERSHIP_PLAN_CODES)
  planCode!: MembershipPlanCode;
}

export class UpgradePreviewQueryDto {
  @IsString()
  @MaxLength(32)
  @IsIn(MEMBERSHIP_PLAN_CODES)
  planCode!: MembershipPlanCode;
}

export class AdminRefundMembershipDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class AdminUpdateMembershipDto {
  @IsString()
  @MaxLength(32)
  action!: 'cancel' | 'extend';

  extendDays?: number;
}
