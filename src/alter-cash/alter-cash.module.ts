import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AlterCashController } from './alter-cash.controller';
import { AlterCashService } from './alter-cash.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AlterCashController],
  providers: [AlterCashService],
  exports: [AlterCashService],
})
export class AlterCashModule {}
