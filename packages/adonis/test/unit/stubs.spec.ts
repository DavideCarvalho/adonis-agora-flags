import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { parseSync } from '@swc/core';
import { describe, expect, it } from 'vitest';

const STUBS = fileURLToPath(new URL('../../stubs/', import.meta.url));

/**
 * Renders every published stub with the real AdonisJS stub engine (what `node ace configure`
 * does) and parses the output as TypeScript, so an unescaped backtick or a broken template fails
 * here instead of in a user's app.
 */
describe('published stubs', () => {
  for (const stub of [
    'config/flags.stub',
    'config/flags_dashboard.stub',
    'database/migrations/create_flags_tables.stub',
  ]) {
    it(`${stub} renders to valid TypeScript`, async () => {
      const app = new AppFactory().create(new URL('./tmp/', import.meta.url), () => {});
      await app.init();
      const stubs = await app.stubs.create();
      const built = await stubs.build(stub, { source: STUBS });
      const { contents, destination } = await built.prepare({});
      expect(destination).toMatch(
        stub.startsWith('config') ? /config[/\\]flags/ : /_create_flags_tables\.ts$/,
      );
      expect(contents).not.toContain('\\`');
      expect(() => parseSync(contents, { syntax: 'typescript' })).not.toThrow();
    });
  }
});
