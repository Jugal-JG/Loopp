import { defineConfig } from '@playwright/test';

const port = Number(process.env.LOOPP_BROWSER_TEST_PORT ?? 4373);
const baseURL = `http://localhost:${port}`;
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { baseURL, channel: 'chrome' },
  globalSetup: './test/browser/setup.ts',
});
