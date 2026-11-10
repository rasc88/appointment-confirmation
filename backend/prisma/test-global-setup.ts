import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: project.config.env.DATABASE_URL },
    stdio: 'pipe',
  });
}
