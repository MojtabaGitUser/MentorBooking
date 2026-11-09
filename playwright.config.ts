import { defineConfig } from '@playwright/test';

const workerJourney = process.env.E2E_WORKER_JOURNEY === '1';
export default defineConfig({
  workers: process.env.E2E_BOOKING_DB ? 1 : undefined,
  outputDir: workerJourney ? 'test-results/worker' : process.env.E2E_BOOKING_DB ? 'test-results/booking' : 'test-results/directory',
  testDir: workerJourney ? './infra/tests/worker-browser' : process.env.E2E_BOOKING_DB ? './infra/tests/booking-browser' : './infra/tests/browser',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000' },
});
