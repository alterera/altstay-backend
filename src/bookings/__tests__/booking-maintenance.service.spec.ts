import { BookingIdempotencyService } from '../booking-idempotency.service';
import { BookingMaintenanceService } from '../booking-maintenance.service';
import { BookingsService } from '../bookings.service';

describe('BookingMaintenanceService', () => {
  let bookings: {
    findExpiredHoldCandidates: jest.Mock;
    expireReservation: jest.Mock;
  };
  let idempotency: { cleanup: jest.Mock };
  let maintenance: BookingMaintenanceService;

  beforeEach(() => {
    bookings = {
      findExpiredHoldCandidates: jest.fn().mockResolvedValue([]),
      expireReservation: jest.fn().mockResolvedValue(true),
    };
    idempotency = {
      cleanup: jest.fn().mockResolvedValue({ expired: 0, stale: 0 }),
    };
    maintenance = new BookingMaintenanceService(
      bookings as unknown as BookingsService,
      idempotency as unknown as BookingIdempotencyService,
    );
    jest
      .spyOn(maintenance['logger'], 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn(maintenance['logger'], 'error')
      .mockImplementation(() => undefined);
  });

  describe('expireHolds', () => {
    it('expires every candidate it is given', async () => {
      bookings.findExpiredHoldCandidates.mockResolvedValue(['a', 'b', 'c']);

      await expect(maintenance.expireHolds()).resolves.toBe(3);
      expect(bookings.expireReservation).toHaveBeenCalledTimes(3);
    });

    it('does nothing when no holds have expired', async () => {
      await expect(maintenance.expireHolds()).resolves.toBe(0);
      expect(bookings.expireReservation).not.toHaveBeenCalled();
    });

    // A reservation another path already moved on reports false, not an error.
    it('does not count candidates that were already resolved elsewhere', async () => {
      bookings.findExpiredHoldCandidates.mockResolvedValue(['a', 'b']);
      bookings.expireReservation
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await expect(maintenance.expireHolds()).resolves.toBe(1);
    });

    it('keeps going after one reservation fails', async () => {
      bookings.findExpiredHoldCandidates.mockResolvedValue(['a', 'b', 'c']);
      bookings.expireReservation.mockImplementation((id: string) =>
        id === 'b'
          ? Promise.reject(new Error('deadlock'))
          : Promise.resolve(true),
      );

      await expect(maintenance.expireHolds()).resolves.toBe(2);
      expect(bookings.expireReservation).toHaveBeenCalledTimes(3);
    });

    it('skips a tick while the previous one is still running', async () => {
      let release: () => void = () => undefined;
      bookings.findExpiredHoldCandidates.mockResolvedValue(['a']);
      bookings.expireReservation.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          }),
      );

      const first = maintenance.expireHolds();
      await Promise.resolve();
      const second = await maintenance.expireHolds();

      expect(second).toBe(0);

      release();
      await expect(first).resolves.toBe(1);
      expect(bookings.findExpiredHoldCandidates).toHaveBeenCalledTimes(1);
    });

    it('releases the overlap guard after a failed run', async () => {
      bookings.findExpiredHoldCandidates.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(maintenance.expireHolds()).rejects.toThrow('db down');

      bookings.findExpiredHoldCandidates.mockResolvedValue([]);
      await expect(maintenance.expireHolds()).resolves.toBe(0);
    });
  });

  describe('cleanupIdempotencyKeys', () => {
    it('sweeps expired and stale claims', async () => {
      idempotency.cleanup.mockResolvedValue({ expired: 2, stale: 1 });

      await maintenance.cleanupIdempotencyKeys();

      expect(idempotency.cleanup).toHaveBeenCalled();
    });

    it('never lets a cleanup failure escape the scheduler', async () => {
      idempotency.cleanup.mockRejectedValue(new Error('db down'));

      await expect(
        maintenance.cleanupIdempotencyKeys(),
      ).resolves.toBeUndefined();
    });
  });
});
