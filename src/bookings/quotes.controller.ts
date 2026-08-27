import { Controller, Get, Query } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuoteSelectionDto } from './dto/quote-selection.dto';

@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  getQuote(@Query() query: QuoteSelectionDto) {
    return this.quotes.getQuote(query);
  }
}
