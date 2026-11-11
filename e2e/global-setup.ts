import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const composeArgs = ['compose', '-p', 'ac-e2e', '-f', 'docker-compose.yaml', '-f', 'e2e/compose.e2e.yaml'];
const healthUrl = 'http://localhost:8085/v1/health';
const healthTimeoutMs = 120_000;

export function runCompose(...args: string[]) {
  const result = spawnSync('docker', [...composeArgs, ...args], { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`docker ${[...composeArgs, ...args].join(' ')} failed`, { cause: result.error });
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  runCompose('logs', 'app');
  throw new Error(`${healthUrl} did not return 200 within ${healthTimeoutMs / 1_000} s`);
}

export default async function globalSetup() {
  runCompose('down', '-v', '--remove-orphans');
  runCompose('up', '-d', '--build');
  await waitForHealth();
}
