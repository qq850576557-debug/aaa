import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'chunmo-pwa-build-version',
      apply: 'build',
      async closeBundle() {
        const html = await readFile('dist/index.html');
        const version = createHash('sha256').update(html).digest('hex').slice(0, 16);
        const sw = await readFile('public/sw.js', 'utf8');
        await writeFile(
          'dist/sw.js',
          sw.replace('chunmo-assistant-shell-v1', `chunmo-assistant-shell-${version}`),
        );
      },
    },
  ],
  server: {
    proxy: {
      '/api': {
        target: process.env.CHUNMO_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
