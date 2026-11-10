import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backendPort = process.env.PORT ?? '3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': `http://localhost:${backendPort}`,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
