import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

// `.env.test` first so it wins over `.env` for anything it defines.
const testEnv = join(process.cwd(), '.env.test');
if (existsSync(testEnv)) {
  config({ path: testEnv });
}
config({ path: join(process.cwd(), '.env') });

/**
 * Point the app at a dedicated test database when one is configured.
 *
 * These suites need a real PostgreSQL: they assert on `SELECT ... FOR UPDATE`
 * behaviour under concurrency, which no in-memory substitute reproduces.
 *
 * Without TEST_DATABASE_URL they run against DATABASE_URL, so every fixture uses
 * a randomized slug/phone namespace and removes itself in `afterAll`.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Booking e2e tests need TEST_DATABASE_URL (preferred) or DATABASE_URL to be set',
  );
}

// The app refuses to boot without these; supply throwaway values if absent.
process.env.JWT_ACCESS_SECRET ??= 'e2e-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'e2e-refresh-secret';

// Payment settings the suites assert against. The payment service itself is always
// stubbed, so the base URL only has to be syntactically real.
process.env.PAYMENT_SERVICE_BASE_URL ??= 'https://pay.e2e.invalid';
process.env.PAYMENT_SERVICE_TOKEN ??= 'e2e-service-token';
process.env.PAYMENT_NOTIFICATION_SIGNING_SECRET ??= 'e2e-notification-secret';
process.env.BOOKING_RESULT_URL ??= 'https://alterstays.e2e.invalid/booking/payment-result';
