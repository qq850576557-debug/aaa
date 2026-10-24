import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
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
