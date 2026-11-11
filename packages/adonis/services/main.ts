import app from '@adonisjs/core/services/app';
import type { FlagsManager } from '../src/manager.js';

/**
 * The flags manager, ready to use:
 *
 * ```ts
 * import flags from '@adonis-agora/flags/services/main'
 *
 * if (await flags.for(user).enabled('new_player')) { … }
 * await flags.track(user, 'purchase', { value: order.total, client: trx })
 * ```
 *
 * Resolved from the container (`flags.manager`), so rebinding it in a test changes what app code
 * gets. In HTTP handlers, `ctx.flags` (from the middleware) is the per-request scope.
 */
let flags: FlagsManager;

await app.booted(async () => {
  flags = await app.container.make('flags.manager');
});

export { flags as default };
