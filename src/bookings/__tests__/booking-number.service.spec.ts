import { InternalServerErrorException } from '@nestjs/common';
import { PricingClient } from '../../pricing/pricing.types';
import { BookingNumberService } from '../booking-number.service';

describe('BookingNumberService', () => {
  let service: BookingNumberService;

  beforeEach(() => {
    service = new BookingNumberService();
  });

  describe('generate', () => {
    it('stamps the UTC date and a 6-character suffix', () => {
      const number = service.generate(new Date('2026-08-19T22:30:00.000Z'));

      expect(number).toMatch(/^ALTSTAY-20260819-[0-9A-HJKMNP-TV-Z]{6}$/);
    });

    it('uses the UTC date rather than the local one', () => {
      // 23:30 UTC on the 19th is already the 20th in IST; the reference must not
      // depend on the server's timezone.
      const number = service.generate(new Date('2026-08-19T23:30:00.000Z'));

      expect(number.startsWith('ALTSTAY-20260819-')).toBe(true);
    });

    it('zero-pads single-digit months and days', () => {
      const number = service.generate(new Date('2026-01-05T00:00:00.000Z'));

      expect(number.startsWith('ALTSTAY-20260105-')).toBe(true);
    });

    it('omits letters that are easy to misread', () => {
      const suffixes = Array.from({ length: 200 }, () =>
        service.generate().slice(-6),
      ).join('');

      expect(suffixes).not.toMatch(/[ILOU]/);
    });

    it('does not repeat across draws', () => {
      const drawn = new Set(
        Array.from({ length: 100 }, () => service.generate().slice(-6)),
      );

      expect(drawn.size).toBeGreaterThan(90);
    });
  });

  describe('generateUnique', () => {
    function mockClient(findUnique: jest.Mock) {
      return {
        client: {
          reservation: { findUnique },
        } as unknown as PricingClient,
        findUnique,
      };
    }

    it('returns the first candidate that is free', async () => {
      const { client, findUnique } = mockClient(
        jest.fn().mockResolvedValue(null),
      );

      const number = await service.generateUnique(client);

      expect(number).toMatch(/^ALTSTAY-\d{8}-/);
      expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('draws again when a candidate is already taken', async () => {
      const { client, findUnique } = mockClient(
        jest
          .fn()
          .mockResolvedValueOnce({ id: 'taken' })
          .mockResolvedValueOnce(null),
      );

      await service.generateUnique(client);

      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('gives up rather than looping forever', async () => {
      const { client } = mockClient(
        jest.fn().mockResolvedValue({ id: 'taken' }),
      );

      await expect(service.generateUnique(client)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
