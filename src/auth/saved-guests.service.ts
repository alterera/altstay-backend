import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSavedGuestDto,
  UpdateSavedGuestDto,
} from './dto/saved-guest.dto';

@Injectable()
export class SavedGuestsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.savedGuest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateSavedGuestDto) {
    return this.prisma.savedGuest.create({
      data: {
        userId,
        name: dto.name.trim(),
        phone: dto.phone.trim(),
        email: dto.email?.trim() || null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateSavedGuestDto) {
    await this.requireOwned(userId, id);
    return this.prisma.savedGuest.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone.trim() } : {}),
        ...(dto.email !== undefined
          ? { email: dto.email?.trim() || null }
          : {}),
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.requireOwned(userId, id);
    await this.prisma.savedGuest.delete({ where: { id } });
    return { success: true };
  }

  private async requireOwned(userId: string, id: string) {
    const guest = await this.prisma.savedGuest.findFirst({
      where: { id, userId },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    return guest;
  }
}
