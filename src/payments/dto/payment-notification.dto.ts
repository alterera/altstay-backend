import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const PAYMENT_EVENT_TYPES = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/**
 * What pay.alterera.net sends us once a provider outcome is verified.
 *
 * `amount` stays a string all the way through. Parsing it into a JS number to
 * compare against a `Decimal(12,2)` column is exactly how amount checks develop
 * false negatives.
 */
export class PaymentNotificationDto {
  @IsString()
  @MaxLength(200)
  eventId!: string;

  @IsIn(PAYMENT_EVENT_TYPES)
  eventType!: PaymentEventType;

  @IsString()
  @MaxLength(200)
  paymentReference!: string;

  @IsString()
  @MaxLength(64)
  reservationReference!: string;

  @IsString()
  @MaxLength(32)
  provider!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerOrderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerPaymentId?: string;

  @Matches(/^\d{1,10}(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string such as "8700.00"',
  })
  amount!: string;

  @IsString()
  @MaxLength(3)
  currency!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  paymentMethod?: string;

  @IsISO8601()
  occurredAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  failureReason?: string | null;
}
