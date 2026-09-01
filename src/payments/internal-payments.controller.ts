import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { isMembershipPaymentReference } from '../membership/membership.utils';
import { MembershipPaymentConfirmationService } from '../membership/membership-payment-confirmation.service';
import { PaymentNotificationDto } from './dto/payment-notification.dto';
import { ServiceSignatureGuard } from './guards/service-signature.guard';
import { PaymentConfirmationService } from './payment-confirmation.service';

/**
 * Where pay.alterera.net reports verified provider outcomes.
 *
 * Mounted under `/internal/` so it can be blocked wholesale at the edge. The
 * signature guard is the only authentication: CORS is not a control here, since
 * the existing policy allows requests with no `Origin` header — which is exactly
 * what a server-to-server call looks like.
 */
@Controller('internal/payments')
@UseGuards(ServiceSignatureGuard)
export class InternalPaymentsController {
  constructor(
    private readonly confirmation: PaymentConfirmationService,
    private readonly membershipConfirmation: MembershipPaymentConfirmationService,
  ) {}

  /**
   * The status code is the retry contract for the sender, so it is set explicitly
   * rather than left to Nest's default for a POST:
   *
   * - 200 processed, 202 accepted but not confirmable — both terminal
   * - 409 an earlier delivery is still in flight, come back later
   * - 422 permanently rejected, stop and alert
   */
  @Post('notifications')
  async notify(
    @Body() dto: PaymentNotificationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isMembershipPaymentReference(dto.paymentReference)) {
      const result = await this.membershipConfirmation.handleNotification(dto);
      res.status(result.httpStatus);
      return { ...result.body, duplicate: result.body.duplicate };
    }

    const result = await this.confirmation.handleNotification(dto);
    res.status(result.httpStatus);
    return result.body;
  }
}
