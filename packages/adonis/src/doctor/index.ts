import type { ApplicationService } from '@adonisjs/core/types';
import {
  type FlagsDashboardConfig,
  resolveConfig as resolveDashboardConfig,
} from '../dashboard/define_config.js';
import type { FlagsConfig } from '../define_config.js';
import { consoleCommandKeys, resolveConsoleCommands } from '../federation/console.js';
import {
  authkitClientOf,
  consoleKeyNote,
  createKeyCommand,
  cryptoRuntimeOf,
  probeCipher,
  probeTenantConsoleKey,
  publicKeyId,
  publishesTokenKey,
  resolveAppConsoleAuth,
  resolveConsoleSideAuth,
} from '../federation/console_auth.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleCryptoOption,
  RedisConsoleChannel,
} from '../federation/redis_channel.js';
import { appKeyOf, releaseSecret } from '../http/browser.js';
import type { FlagsRuntime } from '../runtime.js';
import { missingFlagsColumns } from '../schema.js';
import { LucidStore } from '../stores/lucid_store.js';
import { describeTenantSources, TenantConfigError } from '../topology/authkit_tenant.js';
import { resolveTenantVerifier } from '../topology/verify.js';

/** Structural copy of the agora doctor contract (v1); `node ace agora:doctor` reads it. */
export type AgoraDoctorStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface AgoraDoctorResult {
  status: AgoraDoctorStatus;
  message: string;
  fix?: string;
  docs?: string;
}

export interface AgoraDoctorCheck {
  id: string;
  lib: string;
  title: string;
  cost?: 'cheap' | 'deep';
  run(app: ApplicationService): Promise<AgoraDoctorResult | AgoraDoctorResult[]>;
}

/** The container binding `node ace agora:doctor` reads the checks from (registry version 1). */
export const AGORA_DOCTOR_BINDING = 'agora.doctor';

interface DoctorContainer {
  hasBinding?(binding: string): boolean;
  bindValue?(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

/**
 * Adds the flags checks to the app's doctor registry, creating it when absent (the same contract
 * as the other Agora libs' `registerDoctorChecks`). Without it, `agora:doctor` reports flags as
 * "provider not registered" and runs none of its checks. A registry of another version is left
 * alone; a duplicate id is skipped.
 */
export async function registerDoctorChecks(
  container: DoctorContainer,
  checks: AgoraDoctorCheck[] = agoraDoctorChecks,
): Promise<void> {
  if (typeof container.hasBinding !== 'function' || typeof container.bindValue !== 'function')
    return;
  if (!container.hasBinding(AGORA_DOCTOR_BINDING)) {
    container.bindValue(AGORA_DOCTOR_BINDING, { version: 1, checks: [] });
  }
  const registry = (await container.make(AGORA_DOCTOR_BINDING)) as
    | { version?: unknown; checks?: unknown }
    | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.checks)) return;
  const list = registry.checks as AgoraDoctorCheck[];
  for (const check of checks) {
    if (list.some((existing) => existing.id === check.id)) continue;
    list.push(check);
  }
}

const DOCS = 'https://davidecarvalho.github.io/agora/docs/flags/central-server#transports';
const TENANT_DOCS = 'https://davidecarvalho.github.io/agora/docs/flags/central-server';

interface Checkable {
  readonly driver: string;
  check?(): Promise<void>;
}

async function probe(side: string, link: Checkable): Promise<AgoraDoctorResult> {
  if (!link.check) return { status: 'ok', message: `${side} over ${link.driver}` };
  try {
    await link.check();
    return { status: 'ok', message: `${side} over ${link.driver}: reachable` };
  } catch (error) {
    return {
      status: 'error',
      message: `${side} over ${link.driver}: ${(error as Error).message}`,
      fix: `Check the ${link.driver} connection in config/flags.ts and that the broker is up`,
      docs: DOCS,
    };
  }
}

const CONSOLE_DOCS = 'https://davidecarvalho.github.io/agora/docs/flags/federated-console';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function cipherOf(option: ConsoleCryptoOption): Promise<ConsoleCipher> {
  const source = option.cipher;
  return typeof source === 'function' ? await source() : source;
}

/** The owning app's side of the "console commands" check (`consoleCommands`). */
async function appSide(
  app: ApplicationService,
  probe: boolean,
): Promise<AgoraDoctorResult | undefined> {
  if (!app.container.hasBinding('flags.runtime')) return undefined;
  const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
  const config = runtime.config as FlagsConfig;
  if (config.topology === 'tenant') return undefined;
  const option = resolveConsoleCommands(config.consoleCommands, runtime.manager.app);
  if (!option) return undefined;
  const appKey = releaseSecret(await appKeyOf(app));
  const auth = resolveAppConsoleAuth({
    option,
    fallbackVerifyTenant:
      config.topology === 'control-plane' && config.verifyTenant !== undefined
        ? resolveTenantVerifier(config.verifyTenant)
        : undefined,
    crypto: option.crypto === undefined ? await cryptoRuntimeOf(app.container) : undefined,
    authkit: option.verifyTenant === undefined ? await authkitClientOf(app.container) : undefined,
    hasAppKey: !!appKey && appKey.length >= 16,
    ...(appKey && appKey.length >= 16
      ? { tokenKeyId: publicKeyId(consoleCommandKeys(appKey, option.prefix).publicKey) }
      : {}),
  });
  if (auth.error) {
    // The key check has nothing to say: the console-commands check reports it.
    if (probe) return undefined;
    return {
      status: 'error',
      message: `consoleCommands answers nothing: ${auth.error}`,
      fix: 'Install @adonis-agora/crypto, or set consoleCommands.secret or consoleCommands.verifyTenant in config/flags.ts',
      docs: CONSOLE_DOCS,
    };
  }
  // The boot log's own sentence (§11b).
  const modes = `${auth.modes.join(' + ')}; ${
    option.actions
      ? 'actions on'
      : 'actions off (set consoleCommands.actions to let the console act)'
  }`;
  if (!probe) {
    // §13e: with crypto active the token key is not published; said here, not at boot.
    const unpublished =
      auth.crypto && auth.appKeySealed && !publishesTokenKey(auth)
        ? " (the token key is not published in authkit's directory: crypto is enough)"
        : '';
    return { status: 'ok', message: `console commands: ${modes}${unpublished}` };
  }
  if (!auth.crypto) return undefined;
  const key = auth.crypto.key ?? CONSOLE_CRYPTO_KEY;
  const service = auth.autoCrypto?.runtime.service;
  if (auth.autoCrypto && !service) {
    // A crypto tenant holds decrypt only: the key is checked with a decrypt probe, never getKey.
    const partition = auth.autoCrypto.runtime.partition;
    // The same classifier as the app's boot check; the doctor never creates the key.
    const { outcome, detail } = await probeTenantConsoleKey(auth.autoCrypto.runtime, key);
    const note = consoleKeyNote(auth.autoCrypto.runtime, outcome, key, detail);
    if (!note)
      return { status: 'ok', message: `console commands: ${modes}; the key ${key} is usable` };
    // Missing on a tenant is fine: the crypto server creates it on the console's first seal.
    if (outcome === 'missing')
      return { status: 'ok', message: `console commands: ${modes}. ${note.line}` };
    return {
      status: outcome === 'unreachable' ? 'warn' : 'error',
      message: note.line,
      fix:
        outcome === 'refused'
          ? `An app needs no grant to open its own console-* keys: check this app's crypto token is valid for partition ${partition} and that the crypto server is up to date`
          : `Check that the crypto server is up, then run \`node ace agora:doctor --deep\` again`,
      docs: CONSOLE_DOCS,
    };
  }
  if (service && auth.autoCrypto) {
    const partition = auth.autoCrypto.runtime.partition;
    if (!(await service.store.getKey(partition, key))) {
      return {
        status: 'warn',
        message: `console commands: ${modes}; the key ${key} of "${partition}" does not exist yet`,
        fix: `It is created when the app boots as a web server; or run \`${createKeyCommand(key, partition)}\``,
        docs: CONSOLE_DOCS,
      };
    }
  }
  try {
    const cipher = await cipherOf(auth.crypto);
    await probeCipher(
      (input) => cipher.encrypt(input),
      (input) => cipher.decrypt(input),
      key,
    );
    return { status: 'ok', message: `console commands: ${modes}; the key ${key} round-trips` };
  } catch (error) {
    const partition = auth.autoCrypto?.runtime.partition ?? runtime.manager.app;
    return {
      // An app normally holds decrypt only: a refused encrypt does not mean commands fail.
      status: 'error',
      message: `console commands: ${modes}; a probe with the key ${key} did not round-trip: ${messageOf(error)}`,
      fix: `Check that the key exists (\`${createKeyCommand(key, partition)}\` on the crypto server) and that the cipher in consoleCommands.crypto may use it`,
      docs: CONSOLE_DOCS,
    };
  }
}

/** The console's side: one result per federated app of config/flags_dashboard.ts. */
async function consoleSide(app: ApplicationService, probe: boolean): Promise<AgoraDoctorResult[]> {
  const raw = app.config.get<FlagsDashboardConfig | undefined>('flags_dashboard', undefined);
  if (!raw) return [];
  const config = resolveDashboardConfig(raw);
  if (!config.enabled) return [];
  const entries = Object.entries(config.apps);
  if (entries.length === 0) return [];
  const crypto = await cryptoRuntimeOf(app.container);
  const authkit = await authkitClientOf(app.container);
  const results: AgoraDoctorResult[] = [];
  for (const [key, entry] of entries) {
    const plane = entry.controlPlane;
    const actions = entry.actions !== false;
    if (plane instanceof RedisConsoleChannel) {
      if (probe) continue;
      results.push(
        plane.signed || !actions
          ? { status: 'ok', message: `console commands to "${key}": the RedisConsoleChannel given` }
          : {
              status: 'error',
              message: `the RedisConsoleChannel of "${key}" has no authentication`,
              docs: CONSOLE_DOCS,
            },
      );
      continue;
    }
    const partition = entry.partition ?? key;
    const auth = resolveConsoleSideAuth({ key, partition, plane, actions, crypto, authkit });
    if (auth.error) {
      if (probe) continue;
      results.push({
        status: 'error',
        message: auth.error,
        fix: 'Install @adonis-agora/crypto in this app, or set the controlPlane auth lines, or `actions: false`',
        docs: CONSOLE_DOCS,
      });
      continue;
    }
    if (!probe) {
      results.push({
        status: 'ok',
        message: auth.mode
          ? `console commands to "${key}": ${auth.mode}`
          : `console commands to "${key}": none (browse-only: actions: false)`,
      });
      continue;
    }
    if (!auth.crypto) continue;
    const cryptoKey = auth.crypto.key ?? CONSOLE_CRYPTO_KEY;
    try {
      if (auth.ensureKey) {
        const { service } = auth.ensureKey;
        if (!(await service.store.getKey(partition, cryptoKey))) {
          results.push({
            status: 'warn',
            message: `console commands to "${key}": ${auth.mode}; the key does not exist yet (created when this app boots as a web server)`,
            fix: `Boot this app as a web server, or run \`${createKeyCommand(cryptoKey, partition)}\``,
            docs: CONSOLE_DOCS,
          });
          continue;
        }
        // Embedded: the deep check round-trips in the app's partition.
        const principal = {
          partition,
          capabilities: [`crypto:encrypt:${cryptoKey}`, `crypto:decrypt:${cryptoKey}`],
          actor: 'flags:doctor',
        };
        await probeCipher(
          (input) => service.encrypt(principal, input),
          (input) => service.decrypt(principal, input),
          cryptoKey,
        );
        results.push({
          status: 'ok',
          message: `console commands to "${key}": ${auth.mode}; the key round-trips`,
        });
      } else {
        // The console only encrypts: check that it can.
        const cipher = await cipherOf(auth.crypto);
        await cipher.encrypt({ key: cryptoKey, plaintext: 'agora:doctor', aad: 'agora:doctor' });
        results.push({
          status: 'ok',
          message: `console commands to "${key}": ${auth.mode}; this app can seal with the key`,
        });
      }
    } catch (error) {
      results.push({
        status: 'error',
        message: `console commands to "${key}": ${auth.mode}; sealing with the key failed: ${messageOf(error)}`,
        fix: `Check that the key exists (\`${createKeyCommand(cryptoKey, partition)}\` on the crypto server) and that this app may seal with it (crypto:seal:console-* on a crypto tenant)`,
        docs: CONSOLE_DOCS,
      });
    }
  }
  return results;
}

/** The flags checks `agora:doctor` runs (`--deep` for these). */
export const agoraDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'flags.tenant-transport',
    lib: 'flags',
    title: 'Tenant ↔ control-plane broker reachable',
    cost: 'deep',
    async run(app) {
      if (!app.container.hasBinding('flags.runtime'))
        return { status: 'skip', message: 'the flags provider is not registered' };
      const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
      if (runtime.topology === 'tenant' && runtime.tenantLinks) {
        const { push, watch } = runtime.tenantLinks;
        const results = [await probe('events', push)];
        if (watch !== (push as unknown)) results.push(await probe('ruleset', watch));
        return results;
      }
      if (runtime.topology === 'control-plane') {
        const links = runtime.controlPlane?.links ?? [];
        if (links.length === 0) return { status: 'ok', message: 'tenants connect over HTTP only' };
        return Promise.all(links.map((link) => probe('tenants', link)));
      }
      return { status: 'skip', message: 'standalone: no control-plane' };
    },
  },
  {
    id: 'flags.tenant-source',
    lib: 'flags',
    title: 'Tenant url, token and partition',
    cost: 'cheap',
    async run(app) {
      if (!app.container.hasBinding('flags.runtime'))
        return { status: 'skip', message: 'the flags provider is not registered' };
      try {
        const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
        if (runtime.topology !== 'tenant') return { status: 'skip', message: 'not a tenant' };
        const sources = runtime.tenantSources ?? {
          url: runtime.controlPlaneUrl ? 'explicit' : 'none',
          token: 'explicit',
          partition: 'explicit',
        };
        return { status: 'ok', message: `${describeTenantSources(sources)}.` };
      } catch (error) {
        if (!(error instanceof TenantConfigError)) throw error;
        return {
          status: 'error',
          message: error.message,
          fix: "Configure @adonis-agora/authkit-client's `service`, or pass tenant: { url, token, partition } in config/flags.ts",
          docs: TENANT_DOCS,
        };
      }
    },
  },
  {
    id: 'flags.control-plane-url',
    lib: 'flags',
    title: 'Tenant resolves the control-plane URL',
    cost: 'deep',
    async run(app) {
      if (!app.container.hasBinding('flags.runtime'))
        return { status: 'skip', message: 'the flags provider is not registered' };
      const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
      if (runtime.topology !== 'tenant') return { status: 'skip', message: 'not a tenant' };
      const address = runtime.controlPlaneUrl;
      if (!address) return { status: 'skip', message: 'no tenant.url (broker-only tenant)' };
      try {
        const url = await address.get();
        return { status: 'ok', message: `control plane at ${url}` };
      } catch (error) {
        return {
          status: 'error',
          message: `tenant.url did not resolve: ${(error as Error).message}`,
          fix: 'Check tenant.url in config/flags.ts (or the discovery it calls) and that the control plane is published',
          docs: DOCS,
        };
      }
    },
  },
  {
    id: 'flags.schema-columns',
    lib: 'flags',
    title: 'Flags tables have every column this version writes',
    cost: 'cheap',
    async run(app) {
      if (!app.container.hasBinding('flags.runtime'))
        return { status: 'skip', message: 'the flags provider is not registered' };
      const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
      if (!(runtime.store instanceof LucidStore))
        return { status: 'skip', message: 'the ruleset is not in a Lucid store' };
      const missing = await missingFlagsColumns(runtime.store.db);
      if (missing.length === 0) return { status: 'ok', message: 'the flags tables are current' };
      return {
        status: 'error',
        message: `missing columns: ${missing.join(', ')}`,
        fix: 'Turn autoCreateSchema back on, or add a migration that calls createFlagsTables (it adds missing columns)',
        docs: 'https://davidecarvalho.github.io/agora/docs/flags/getting-started',
      };
    },
  },
  {
    id: 'flags.console-commands',
    lib: 'flags',
    title: 'Federated console commands are authenticated',
    cost: 'cheap',
    async run(app) {
      const results = [
        ...[(await appSide(app, false)) ?? []].flat(),
        ...(await consoleSide(app, false)),
      ];
      if (results.length === 0) {
        return { status: 'skip', message: 'no consoleCommands and no federated apps' };
      }
      return results;
    },
  },
  {
    id: 'flags.console-commands-key',
    lib: 'flags',
    title: 'The console commands crypto key exists and works',
    cost: 'deep',
    async run(app) {
      const results = [
        ...[(await appSide(app, true)) ?? []].flat(),
        ...(await consoleSide(app, true)),
      ];
      if (results.length === 0) return { status: 'skip', message: 'no crypto mode resolved' };
      return results;
    },
  },
];
