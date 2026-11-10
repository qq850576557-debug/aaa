import { defineConfig } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.loadEnvFile('.env.test.local');
process.env.APP_ORIGIN = 'http://127.0.0.1:5181';
process.env.CHUNMO_API_TARGET = 'http://127.0.0.1:4001';
process.env.CHUNMO_PHOTO_DIR = mkdtempSync(join(tmpdir(), 'chunmo-mobile-pwa-'));
export default defineConfig({
  testDir: './cloud-tests',
  testMatch: ['mobile-assistant.spec.ts', 'mobile-photo-v11.spec.ts', 'mobile-v12.spec.ts'],
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: process.env.APP_ORIGIN,
    headless: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
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
      command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5181 --strictPort',
      url: process.env.APP_ORIGIN,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  reporter: [['list']],
});
