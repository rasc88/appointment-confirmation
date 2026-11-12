import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { prisma } from './db.js';
import { ApiError } from './errors.js';
import { Prisma } from './generated/prisma/client.js';
import { hashPassword } from './passwords.js';
import { createStaffMemberSchema, isUniqueViolation } from './staff-routes.js';
import { parseBody } from './validation.js';

const usage = 'Usage: npm run staff:create (takes no arguments; it prompts for name, email, and password)\n';
/** The pg adapter can put a driver code such as `ECONNREFUSED` in `code`; only Prisma's own codes are printed. */
const prismaCodePattern = /^P\d{4}$/;
const inputEndedMessage = 'Input ended before all answers were given; nothing was created.\n';

let isOutputMuted = false;

/** Readline echoes typed keys through its output, so muting it hides the password, even as `*`. */
const promptOutput = new Writable({
  write(chunk: Buffer, encoding, callback) {
    if (!isOutputMuted) {
      process.stdout.write(chunk);
    }
    callback();
  },
});

/** The line iterator buffers piped lines that arrive before their prompt is shown. */
async function readAnswers() {
  const isTerminal = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: promptOutput, terminal: isTerminal, historySize: 0 });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => {
    rl.close();
    process.stdout.write('\n');
    process.exit(130);
  });
  async function ask(prompt: string, isSecret: boolean) {
    rl.setPrompt(prompt);
    rl.prompt();
    isOutputMuted = isSecret;
    const { value, done } = await lines.next();
    isOutputMuted = false;
    return done ? undefined : value;
  }
  const name = await ask('Name: ', false);
  const email = name === undefined ? undefined : await ask('Email: ', false);
  const password = email === undefined ? undefined : await ask('Password: ', true);
  rl.close();
  process.stdout.write('\n');
  return password === undefined ? undefined : { name, email, password };
}

/** Never includes the error message: Prisma messages echo query arguments and the URL holds the password. */
export function describeFailure(error: unknown) {
  if (error instanceof ApiError) {
    return `${error.field}: ${error.message}`;
  }
  if (isUniqueViolation(error)) {
    return 'email: Another staff account already has this email.';
  }
  const isPrismaCode = error instanceof Prisma.PrismaClientKnownRequestError && prismaCodePattern.test(error.code);
  return `Could not create the staff account: ${isPrismaCode ? error.code : 'database error'}`;
}

async function createStaffAccount() {
  if (process.argv.length > 2) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const answers = await readAnswers();
  if (!answers) {
    process.stderr.write(inputEndedMessage);
    process.exitCode = 1;
    return;
  }
  try {
    const { name, email, password } = parseBody(createStaffMemberSchema, answers);
    const staffMember = await prisma.staffMember.create({
      data: { name, email: email.toLowerCase(), passwordHash: await hashPassword(password) },
    });
    process.stdout.write(`Created staff account ${staffMember.id}.\n`);
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  await createStaffAccount();
}
