import { normalizePhone, toGatewayPhoneNumber } from './auth.utils';

describe('normalizePhone', () => {
  it('prepends +91 for 10-digit national numbers starting with 91', () => {
    expect(normalizePhone('9101795134', '+91')).toBe('+919101795134');
  });

  it('prepends +91 for plain 10-digit national numbers', () => {
    expect(normalizePhone('9876543210', '+91')).toBe('+919876543210');
  });

  it('keeps fully qualified Indian numbers unchanged', () => {
    expect(normalizePhone('919101795134', '+91')).toBe('+919101795134');
    expect(normalizePhone('+919101795134', '+91')).toBe('+919101795134');
  });

  it('fixes mistaken + prefix on a national number', () => {
    expect(normalizePhone('+9101795134', '+91')).toBe('+919101795134');
  });

  it('strips a leading trunk zero before normalization', () => {
    expect(normalizePhone('09101795134', '+91')).toBe('+919101795134');
  });

  it('defaults to India when country code is omitted', () => {
    expect(normalizePhone('9101795134')).toBe('+919101795134');
  });
});

describe('toGatewayPhoneNumber', () => {
  it('returns digits-only E.164 for WhatsApp gateway', () => {
    expect(toGatewayPhoneNumber('+919101795134')).toBe('919101795134');
    expect(toGatewayPhoneNumber(normalizePhone('9101795134', '+91'))).toBe(
      '919101795134',
    );
  });
});
