import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
process.loadEnvFile('.env.test.local');
process.env.APP_ORIGIN = 'http://127.0.0.1:5180';
process.env.CHUNMO_API_TARGET = 'http://127.0.0.1:4001';
export default defineConfig({
  testDir: './cloud-tests',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.APP_ORIGIN,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run api:test',
      url: 'http://127.0.0.1:4001/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5180 --strictPort',
      url: process.env.APP_ORIGIN,
      reuseExistingServer: false,
    },
  ],
  reporter: [['list']],
});
