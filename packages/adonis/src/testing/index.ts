import type { JsonValue, Ruleset } from '@adonis-agora/flags-core';
import type { FlagDeclaration } from '../declare.js';
import { EventBuffer } from '../events/buffer.js';
import { FlagsManager } from '../manager.js';
import { StaticSource } from '../ruleset_source.js';
import { getRuntime } from '../services/accessor.js';
import { MemoryTransport } from '../transports/memory_transport.js';
import type { FlagKey } from '../types.js';

/**
 * Fakes flag values in a test of a booted app and restores them afterwards:
 *
 * ```ts
 * test('one-page checkout', async ({ cleanup }) => {
 *   cleanup(fakeFlags({ checkout: 'one_page' }))
 *   // …request the page…
 * })
 * ```
 */
export function fakeFlags(values: Partial<Record<FlagKey, JsonValue>>): () => void {
  return getRuntime().manager.fake(values);
}

/**
 * A manager with no database, for unit tests of code that takes a manager or scope: give it the
 * declarations and an optional ruleset; tracked and exposure events land in `events`.
 */
export function createTestFlags<F extends Record<string, FlagDeclaration>>(options: {
  flags: F;
  ruleset?: Partial<Ruleset>;
  app?: string;
}) {
  const source = new StaticSource({
    schemaVersion: 1,
    version: '1',
    flags: {},
    segments: {},
    ...options.ruleset,
  });
  const transport = new MemoryTransport();
  const buffer = new EventBuffer(transport, { maxSize: 1 });
  const manager = new FlagsManager({
    app: options.app ?? 'test',
    environment: 'test',
    declarations: options.flags,
    source,
    buffer,
    transport,
  });
  return {
    manager,
    /** Replaces the ruleset. */
    setRuleset(ruleset: Partial<Ruleset>) {
      source.replace({
        schemaVersion: 1,
        version: String(Date.now()),
        flags: {},
        segments: {},
        ...ruleset,
      });
    },
    /** Every event recorded so far (exposures and tracks). */
    async events() {
      await buffer.flush();
      return transport.log.map((entry) => entry.event);
    },
  };
}
