import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { DATABASE_URL: 'postgresql://app:app@localhost:5432/appointments_test' },
    globalSetup: './prisma/test-global-setup.ts',
    fileParallelism: false,
  },
});
