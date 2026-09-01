import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AlterCashService } from './alter-cash.service';

type AuthRequest = { user: { id: string } };

@Controller('alter-cash')
@UseGuards(JwtAuthGuard)
export class AlterCashController {
  constructor(private readonly alterCash: AlterCashService) {}

  @Get('me')
  async getSummary(@Req() req: AuthRequest) {
    const [balance, history] = await Promise.all([
      this.alterCash.getBalance(req.user.id),
      this.alterCash.getHistory(req.user.id, { page: 1, limit: 5 }),
    ]);

    return {
      balance,
      recentTransactions: history.items,
    };
  }

  @Get('history')
  getHistory(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.alterCash.getHistory(req.user.id, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
