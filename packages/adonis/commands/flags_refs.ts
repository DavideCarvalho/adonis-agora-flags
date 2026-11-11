import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { flags } from '@adonisjs/core/ace';
import { FlagsCommand } from './shared.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.edge', '.vue', '.svelte']);
const SKIP = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  'tmp',
  'storage',
  'public',
  'coverage',
]);

export interface Reference {
  key: string;
  file: string;
  line: number;
}

/** Finds `'key'` / `"key"` / `` `key` `` string literals for every known key. Exported for tests. */
export async function findReferences(root: string, keys: string[]): Promise<Reference[]> {
  const out: Reference[] = [];
  if (keys.length === 0) return out;
  const escaped = keys
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(['"\`])(${escaped.join('|')})\\1`, 'g');
  const walk = async (dir: string) => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
        const lines = (await readFile(full, 'utf8')).split('\n');
        lines.forEach((text, i) => {
          for (const match of text.matchAll(pattern))
            out.push({ key: match[2]!, file: relative(root, full), line: i + 1 });
        });
      }
    }
  };
  await walk(root);
  return out;
}

export default class FlagsRefs extends FlagsCommand {
  static override commandName = 'flags:refs';
  static override description = 'Where each flag is used in the code, and which flags nothing uses';

  @flags.string({ description: 'Only this flag' })
  declare flag?: string;

  override async run() {
    const runtime = await this.runtime();
    const ruleset = runtime.source.current();
    const keys = this.flag
      ? [this.flag]
      : [...new Set([...Object.keys(runtime.manager.declarations), ...Object.keys(ruleset.flags)])];
    const refs = await findReferences(this.app.appRoot.pathname, keys);
    const byKey = new Map<string, typeof refs>();
    for (const ref of refs) {
      // The declaration in config/flags.ts is not a use.
      if (ref.file.startsWith('config/flags.')) continue;
      byKey.set(ref.key, [...(byKey.get(ref.key) ?? []), ref]);
    }
    for (const key of keys.sort()) {
      const uses = byKey.get(key) ?? [];
      if (uses.length === 0) this.logger.warning(`${key}: no references (candidate for removal)`);
      else this.logger.info(`${key}: ${uses.map((u) => `${u.file}:${u.line}`).join(', ')}`);
    }
  }
}
