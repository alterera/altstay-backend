import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { QuoteSelectionDto } from './quote-selection.dto';

/** Intent request — optional coin redemption at checkout. */
export class BookingIntentDto extends QuoteSelectionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  coinsToRedeem?: number;
}
