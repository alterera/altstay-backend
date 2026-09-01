import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MembershipService } from './membership.service';

@Injectable()
export class MembershipCronService {
  private readonly logger = new Logger(MembershipCronService.name);

  constructor(private readonly membership: MembershipService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async expireMemberships(): Promise<void> {
    const count = await this.membership.expireStaleMemberships();
    if (count > 0) {
      this.logger.log(`Expired ${count} stale memberships`);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async expireAbandonedPurchases(): Promise<void> {
    const count = await this.membership.expireAbandonedPurchases();
    if (count > 0) {
      this.logger.log(`Expired ${count} abandoned membership purchases`);
    }
  }
}
