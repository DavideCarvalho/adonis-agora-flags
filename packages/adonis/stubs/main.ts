import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** Absolute path to the published stubs directory (`dist/stubs/`), computed lazily. */
export function stubsRoot(): string {
  if (cached === undefined) cached = fileURLToPath(new URL('./', import.meta.url));
  return cached;
}
