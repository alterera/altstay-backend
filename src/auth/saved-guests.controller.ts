import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  CreateSavedGuestDto,
  UpdateSavedGuestDto,
} from './dto/saved-guest.dto';
import { SavedGuestsService } from './saved-guests.service';

@Controller('guests')
@UseGuards(JwtAuthGuard)
export class SavedGuestsController {
  constructor(private readonly guests: SavedGuestsService) {}

  @Get()
  list(@Req() req: Request & { user: { id: string } }) {
    return this.guests.list(req.user.id);
  }

  @Post()
  create(
    @Req() req: Request & { user: { id: string } },
    @Body() dto: CreateSavedGuestDto,
  ) {
    return this.guests.create(req.user.id, dto);
  }

  @Patch(':id')
  update(
    @Req() req: Request & { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: UpdateSavedGuestDto,
  ) {
    return this.guests.update(req.user.id, id, dto);
  }

  @Delete(':id')
  remove(
    @Req() req: Request & { user: { id: string } },
    @Param('id') id: string,
  ) {
    return this.guests.remove(req.user.id, id);
  }
}
