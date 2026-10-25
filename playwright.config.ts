import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
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
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    env: { VITE_ALLOW_LOCAL: 'true' },
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
