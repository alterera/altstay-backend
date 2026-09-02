import { BadRequestException } from '@nestjs/common';
import { assertDateRange } from './admin.utils';

describe('assertDateRange', () => {
  it('returns nights for a valid range', () => {
    const nights = assertDateRange('2026-09-01', '2026-09-04');
    expect(nights).toHaveLength(3);
  });

  it('rejects empty ranges', () => {
    expect(() => assertDateRange('2026-09-01', '2026-09-01')).toThrow(
      BadRequestException,
    );
  });

  it('rejects ranges over 366 nights', () => {
    expect(() => assertDateRange('2026-01-01', '2027-01-03')).toThrow(
      BadRequestException,
    );
  });
});
