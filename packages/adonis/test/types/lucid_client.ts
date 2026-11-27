/**
 * Compile-time regression test, type-checked by `test/unit/types.spec.ts`: a real Lucid database,
 * connection and transaction are accepted as the `client` of `track()`.
 */
import type { Database } from '@adonisjs/lucid/database';
import type { TransactionClientContract } from '@adonisjs/lucid/types/database';
import type { FlagsManager, FlagsScope } from '../../src/manager.js';

declare const flags: FlagsManager;
declare const scope: FlagsScope;
declare const db: Database;
declare const trx: TransactionClientContract;

await flags.track({ id: 'u1' }, 'checkout', { client: trx });
await flags.track({ id: 'u1' }, 'checkout', { client: db.connection() });
await flags.track({ id: 'u1' }, 'checkout', { client: db });
await db.transaction(async (client) => {
  await scope.track('checkout', { value: 42, client });
});
