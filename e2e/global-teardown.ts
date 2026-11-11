import { runCompose } from './global-setup.js';

export default function globalTeardown() {
  runCompose('down', '-v', '--remove-orphans');
}
