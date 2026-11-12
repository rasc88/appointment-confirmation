import bcrypt from 'bcryptjs';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { createTestStaff, resetDatabase } from './test-helpers.js';

const usage = 'Usage: npm run staff:create (takes no arguments; it prompts for name, email, and password)\n';
const validAnswers = { name: 'Quinta Owner', email: 'Quinta.Owner@Shop.test', password: 'hidden-pass-7Q' };

type Answers = { name: string; email: string; password: string };

/** `spawnSync` rather than `execFileSync`, so a failing run still returns its exit code and both streams. */
function runStaffCreate(input: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { status, stdout, stderr } = spawnSync('npx', ['tsx', 'src/staff-create.ts', ...args], {
    cwd: `${import.meta.dirname}/..`,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
  return { status, stdout, stderr, output: stdout + stderr };
}

function answer({ name, email, password }: Answers) {
  return runStaffCreate(`${name}\n${email}\n${password}\n`);
}

function expectNoTypedValues(output: string, answers: Partial<Answers>) {
  for (const value of Object.values(answers)) {
    if (value) {
      expect(output).not.toContain(value);
    }
  }
}

function readStaff() {
  return prisma.staffMember.findMany({ orderBy: { id: 'asc' } });
}

async function expectRejected(answers: Answers, message: string) {
  const before = await readStaff();
  const result = answer(answers);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(`${message}\n`);
  expectNoTypedValues(result.output, answers);
  expect(await readStaff()).toEqual(before);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('npm run staff:create', { timeout: 30_000 }, () => {
  it('creates an active account under APP_ENV=production and prints only its id', async () => {
    const result = runStaffCreate(
      `${validAnswers.name}\n${validAnswers.email}\n${validAnswers.password}\n`,
      [],
      { APP_ENV: 'production' },
    );

    const [staffMember] = await readStaff();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`Name: Email: Password: \nCreated staff account ${staffMember.id}.\n`);
    expect(staffMember.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expectNoTypedValues(result.output, validAnswers);
    expect(staffMember).toMatchObject({ name: validAnswers.name, email: 'quinta.owner@shop.test', isActive: true });
    expect(bcrypt.getRounds(staffMember.passwordHash)).toBe(12);
    expect(await bcrypt.compare(validAnswers.password, staffMember.passwordHash)).toBe(true);
  });

  it('creates an account that can sign in with the typed email in any case', async () => {
    expect(answer(validAnswers).status).toBe(0);

    const response = await request(createApp())
      .post('/v1/auth/login')
      .send({ email: 'QUINTA.owner@shop.TEST', password: validAnswers.password });

    expect(response.status).toBe(200);
  });

  it('stores the name exactly as typed, counting code points', async () => {
    const name = ` ${'😀'.repeat(79)}`;
    const result = answer({ ...validAnswers, name });

    expect(result.status).toBe(0);
    expectNoTypedValues(result.output, { ...validAnswers, name });
    expect((await prisma.staffMember.findFirstOrThrow()).name).toBe(name);
  });

  it.each([
    ['an 8-character password', 'Pw8chars'],
    ['a 72-character password', 'p'.repeat(72)],
  ])('accepts %s', async (label, password) => {
    const result = answer({ ...validAnswers, password });

    expect(result.status).toBe(0);
    expectNoTypedValues(result.output, { ...validAnswers, password });
    expect(await readStaff()).toHaveLength(1);
  });

  it.each([
    ['an empty name', { name: '' }, 'name: Must be between 1 and 80 characters.'],
    ['an 81-code-point name', { name: '😀'.repeat(81) }, 'name: Must be between 1 and 80 characters.'],
    ['an email without @', { email: 'not-an-email' }, 'email: Enter a valid email address.'],
    ['an email with a space', { email: 'quinta owner@shop.test' }, 'email: Enter a valid email address.'],
    ['a 255-character email', { email: `${'e'.repeat(245)}@shop.test` }, 'email: Enter a valid email address.'],
    ['a 7-character password', { password: 'Pw7char' }, 'password: Must be between 8 and 72 characters.'],
    ['a 73-character password', { password: 'p'.repeat(73) }, 'password: Must be between 8 and 72 characters.'],
    ['an empty name before a bad email', { name: '', email: 'not-an-email' }, 'name: Must be between 1 and 80 characters.'],
  ])('rejects %s', async (label, change, message) => {
    await createTestStaff({ email: 'other@shop.test' });

    await expectRejected({ ...validAnswers, ...change }, message);
  });

  it.each([
    ['an active account', true],
    ['an inactive account', false],
  ])('refuses an email that %s already has, in any case', async (label, isActive) => {
    await createTestStaff({ email: 'quinta.owner@shop.test', isActive });

    await expectRejected(validAnswers, 'email: Another staff account already has this email.');
  });

  it('creates nothing when input ends before the password', async () => {
    const result = runStaffCreate(`${validAnswers.name}\n${validAnswers.email}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Input ended before all answers were given; nothing was created.\n');
    expectNoTypedValues(result.output, validAnswers);
    expect(await readStaff()).toEqual([]);
  });

  it('refuses any argument before prompting', async () => {
    const result = runStaffCreate(`${validAnswers.name}\n${validAnswers.email}\n${validAnswers.password}\n`, [
      '--password',
      validAnswers.password,
    ]);

    expect(result).toMatchObject({ status: 2, stdout: '', stderr: usage });
    expectNoTypedValues(result.output, validAnswers);
    expect(await readStaff()).toEqual([]);
  });

  it('prints only the Prisma code when the database is unreachable', async () => {
    const databaseUrl = 'postgresql://app:app@localhost:1/appointments_test';
    const result = runStaffCreate(`${validAnswers.name}\n${validAnswers.email}\n${validAnswers.password}\n`, [], {
      DATABASE_URL: databaseUrl,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Could not create the staff account: (P\d{4}|database error)\n$/);
    expect(result.output).not.toContain(databaseUrl);
    expectNoTypedValues(result.output, validAnswers);
  });
});
