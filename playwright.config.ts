import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './infra/tests/browser',
  use: { baseURL: 'http://127.0.0.1:3000' },
});
