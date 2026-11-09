import { defineConfig } from '@playwright/test';

export default defineConfig({
  outputDir: process.env.E2E_BOOKING_DB ? 'test-results/booking' : 'test-results/directory',
  testDir: process.env.E2E_BOOKING_DB ? './infra/tests/booking-browser' : './infra/tests/browser',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000' },
});
