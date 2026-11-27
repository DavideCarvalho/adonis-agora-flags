import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/flags`:
 *
 * 1. registers the providers (flags and the console) and the commands in `adonisrc.ts`;
 * 2. registers `ctx.flags` (router middleware) and the `flag` route guard (named middleware);
 * 3. publishes `config/flags.ts`, `config/flags_dashboard.ts` (the console) and the optional migration
 *    (`--topology=tenant`: a tenant's `config/flags.ts`, whose url, token and partition come from
 *    authkit-client);
 * 4. adds `FLAGS_ENVIRONMENT` to the env validations.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // biome-ignore lint/suspicious/noExplicitAny: `updateRcFile` types its callback loosely.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonis-agora/flags/flags_provider');
    rcFile.addProvider('@adonis-agora/flags/dashboard_provider');
    rcFile.addCommand('@adonis-agora/flags/commands');
  });

  await codemods.registerMiddleware('router', [{ path: '@adonis-agora/flags/flags_middleware' }]);
  await codemods.registerMiddleware('named', [
    { name: 'flag', path: '@adonis-agora/flags/flag_middleware' },
  ]);

  const stubs = stubsRoot();
  // `--topology=tenant`: an app of a Hub's flags control plane, in the one-line form.
  const tenant = command.parsedFlags?.topology === 'tenant';
  await codemods.makeUsingStub(
    stubs,
    tenant ? 'config/flags_tenant.stub' : 'config/flags.stub',
    {},
  );
  await codemods.makeUsingStub(stubs, 'config/flags_dashboard.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_flags_tables.stub', {});

  await codemods.defineEnvValidations({
    leadingComment: 'Feature flags',
    variables: { FLAGS_ENVIRONMENT: 'Env.schema.string.optional()' },
  });

  command.logger.info(
    'With @adonisjs/shield, a central flags server or frontends reading flags (`browser`): exempt the token-authenticated flags API from CSRF in config/shield.ts — `exceptRoutes: (ctx) => flagsCsrfExceptions(ctx.request.url())`, imported from @adonis-agora/flags.',
  );
}
