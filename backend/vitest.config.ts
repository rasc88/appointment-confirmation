import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: 'postgresql://app:app@localhost:5432/appointments_test',
      SESSION_SECRET: 'test-only-session-secret-at-least-32-characters',
      PUBLIC_BASE_URL: 'http://localhost:5173',
    },
    globalSetup: './prisma/test-global-setup.ts',
    fileParallelism: false,
  },
});
