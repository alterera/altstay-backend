import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../admin/uploads/uploads.module';
import { PricingModule } from '../pricing/pricing.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [PrismaModule, UploadsModule, PricingModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
