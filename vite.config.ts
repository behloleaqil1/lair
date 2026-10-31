import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    setupFiles: ['src/server/decisions/testing/raise-guard.ts'],
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The server accepts the dashboard only from port 5173 (or 4777); if 5173 is
    // busy, fail instead of moving to 5174, whose Origin would get HTTP 403
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4777',
    },
  },
});
