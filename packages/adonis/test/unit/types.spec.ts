import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/** Type-checks the compile-time regression tests in `test/types`. */
test('the public types accept real Lucid clients', () => {
  const tsc = fileURLToPath(new URL('../../../../node_modules/.bin/tsc', import.meta.url));
  const project = fileURLToPath(new URL('../types/tsconfig.json', import.meta.url));
  let output = '';
  try {
    execFileSync(tsc, ['-p', project], { stdio: 'pipe', encoding: 'utf8' });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  expect(output).toBe('');
}, 120_000);
