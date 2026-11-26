import type { OkpJwk } from '../crypto-kit/index.js';
import { resolveTenantToken, type TenantTokenSource } from '../topology/token.js';
import type { TenantVerifier, TenantVerifierOption } from '../topology/verify.js';
import {
  type ChannelSecret,
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleCryptoOption,
} from './redis_channel.js';

/**
 * How the federated console's commands are authenticated, decided once at boot on each side, the
 * same way in every Agora lib (see "Authenticating the console" in the docs):
 *
 * - explicit options (`crypto`, `secret`, `token` / `verifyTenant`) are used as given;
 * - otherwise the sibling libs booted in the same app are reused: `@adonis-agora/crypto` seals the
 *   commands with its key `console-flags` of the owning app's partition (embedded in this app, or
 *   through this app's crypto tenant channel), and authkit's calls between apps add a token;
 * - otherwise the boot fails, naming the lines to add.
 *
 * Neither lib is imported: their runtimes are found in the container (`'agora.crypto'`,
 * `'authkit.client'`) and used structurally. None is required (see "Bring your own").
 */

const PACKAGE = '@adonis-agora/flags';
const LIB_NAME = 'flags';

/** The `encrypt`/`decrypt` input `@adonis-agora/crypto` takes. */
type CipherInput = Parameters<ConsoleCipher['encrypt']>[0];
type DecipherInput = Parameters<ConsoleCipher['decrypt']>[0];

/** Who a call to an embedded crypto service is made as. */
export interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** What this lib uses of `@adonis-agora/crypto`'s runtime (`'agora.crypto'` in the container). */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** The app name on a standalone/control-plane, the partition on a tenant. */
  partition: string;
  /** Set where crypto is embedded in this app (standalone or control plane). */
  service?: {
    encrypt(principal: CryptoPrincipalLike, input: CipherInput): Promise<{ ciphertext: string }>;
    decrypt(principal: CryptoPrincipalLike, input: DecipherInput): Promise<{ plaintext: string }>;
    createKey(
      principal: CryptoPrincipalLike,
      input: { name: string; type: string },
    ): Promise<unknown>;
    store: { getKey(partition: string, name: string): Promise<unknown> };
  };
  /** This app's own calls: in-process on a server, to the crypto server on a tenant. */
  operations: {
    encrypt(input: CipherInput & { partition?: string }): Promise<{ ciphertext: string }>;
    decrypt(input: DecipherInput): Promise<{ plaintext: string }>;
    getKey?(name: string): Promise<unknown>;
    /**
     * §13f: whether this app's partition has the key, without an audited decrypt failure (newer
     * crypto). A missing key is `false`.
     */
    hasKey?(input: { key: string }): Promise<boolean>;
    createKey?(input: { name: string; type: string; description?: string }): Promise<unknown>;
  };
}

/** What a caller learns from an authkit app-call token (`verifyToken`). */
export interface AppCaller {
  app: string;
  capabilities: string[];
  clientId?: string;
  expiresAt?: number;
}

/** What this lib uses of `@adonis-agora/authkit-client` (`'authkit.client'` in the container). */
export interface AuthkitClientLike {
  appCallTokens?():
    | { token(app: string): Promise<string>; reset?(app?: string): void }
    | undefined
    | null;
  appCallerVerifier?():
    | { verifyToken(token: string): Promise<AppCaller | null> }
    | null
    | undefined;
  /** authkit's key directory (§2e.B): publish this app's public key for a purpose (background). */
  publishAppKey?(input: { purpose: string; jwk: OkpJwk }): Promise<void>;
  /** authkit's key directory: another app's public key for a purpose (cached), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<OkpJwk | null>;
}

export const CRYPTO_BINDING = 'agora.crypto';
export const AUTHKIT_BINDING = 'authkit.client';

interface ContainerLike {
  hasBinding(binding: never): boolean;
  make(binding: never): Promise<unknown>;
}

async function bound<T>(container: unknown, binding: string): Promise<T | undefined> {
  const c = container as ContainerLike;
  if (typeof c?.hasBinding !== 'function' || !c.hasBinding(binding as never)) return undefined;
  return (await c.make(binding as never)) as T | undefined;
}

/** `@adonis-agora/crypto`'s runtime when it is booted in this app, else `undefined`. */
export async function cryptoRuntimeOf(container: unknown): Promise<CryptoRuntimeLike | undefined> {
  const runtime = await bound<CryptoRuntimeLike>(container, CRYPTO_BINDING);
  if (!runtime || typeof runtime !== 'object' || !runtime.operations) return undefined;
  return runtime;
}

/** `@adonis-agora/authkit-client` when it is booted in this app, else `undefined`. */
export async function authkitClientOf(container: unknown): Promise<AuthkitClientLike | undefined> {
  const client = await bound<AuthkitClientLike>(container, AUTHKIT_BINDING);
  return client && typeof client === 'object' ? client : undefined;
}

/** authkit's app-call token source for the app `target`, when its calls between apps are set up. */
function appCallTokenSource(
  authkit: AuthkitClientLike | undefined,
  target: string,
): TenantTokenSource | undefined {
  const tokens = typeof authkit?.appCallTokens === 'function' ? authkit.appCallTokens() : undefined;
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  return {
    get: () => tokens.token(target),
    invalidate: () => tokens.reset?.(target),
  };
}

/**
 * authkit's app-call verifier as a `verifyTenant`: the token's audience binds it to this app, so the
 * caller (the console app) is its partition, marked `appCall` (the partition rule does not apply).
 */
function appCallVerifier(authkit: AuthkitClientLike | undefined): TenantVerifier | undefined {
  const verifier =
    typeof authkit?.appCallerVerifier === 'function' ? authkit.appCallerVerifier() : undefined;
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  return async ({ token }) => {
    if (!token) return null;
    const caller = await verifier.verifyToken(token);
    if (!caller || typeof caller.app !== 'string' || !Array.isArray(caller.capabilities)) {
      return null;
    }
    return {
      partition: caller.app,
      capabilities: caller.capabilities.filter((c) => typeof c === 'string'),
      appCall: true,
      ...(typeof caller.clientId === 'string' ? { clientId: caller.clientId } : {}),
      ...(typeof caller.expiresAt === 'number' ? { expiresAt: caller.expiresAt } : {}),
    } as ReturnType<TenantVerifier> & object;
  };
}

/** Verifiers tried in order: the first that accepts the token wins. */
function anyVerifier(verifiers: TenantVerifier[]): TenantVerifier {
  return async (request) => {
    for (const verify of verifiers) {
      try {
        const verified = await verify(request);
        if (verified) return verified;
      } catch {
        // Not this verifier's token: try the next.
      }
    }
    return null;
  };
}

/** The actor this lib's own calls to an embedded crypto service are audited as. */
const ACTOR = 'flags:console';

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Make sure the console key exists in `partition` of an embedded crypto service (idempotent).
 * `'created'` or `'exists'`.
 */
export async function ensureConsoleKey(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'created' | 'exists'> {
  const existing = (await service.store.getKey(partition, key)) as { deletedAt?: unknown } | null;
  if (existing && !existing.deletedAt) return 'exists';
  if (existing) {
    throw new Error(
      `[${PACKAGE}] the @adonis-agora/crypto key "${key}" of "${partition}" was deleted; console commands need it (restore it, or set an explicit \`crypto: { cipher, key }\`)`,
    );
  }
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: ACTOR },
      { name: key, type: 'aes256-gcm' },
    );
    return 'created';
  } catch (error) {
    // Another instance created it first.
    if (codeOf(error) === 'conflict') return 'exists';
    throw error;
  }
}

/** The line to run on the crypto server for `key` of `partition`. */
export function createKeyCommand(key: string, partition: string): string {
  return `node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the key-check block calls on this app's crypto. */
type CryptoOperationsLike = CryptoRuntimeLike['operations'];

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** Runs `ensure` once; a failure (crypto's database down at boot) is retried by the next call. */
function once(ensure: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= ensure().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/**
 * The doctor's read-only view of {@link checkTenantConsoleKey} (never creates the key): `hasKey`
 * when crypto offers it (a `forbidden` throw is "refused", any other throw falls back), else the
 * dummy decrypt, classified the same way.
 */
export async function probeTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ outcome: ConsoleKeyOutcome; detail?: string }> {
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    try {
      return { outcome: (await hasKey.call(runtime.operations, { key })) ? 'usable' : 'missing' };
    } catch (error) {
      if (isForbidden(error)) return { outcome: 'refused', detail: errorText(error) };
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return { outcome: 'usable' };
  } catch (error) {
    return { outcome: classifyConsoleKeyError(error), detail: errorText(error) };
  }
}

/**
 * Makes sure a key exists without ever failing the boot: {@link KeyGuard.boot} tries and logs one
 * actionable line on failure; {@link KeyGuard.wrap} retries before the next command (one attempt
 * per command, shared by concurrent ones) until one succeeds, or only once when `retry: 'once'`.
 */
export interface KeyGuard {
  boot(log: { warn(line: string): void; info?(line: string): void }): Promise<boolean>;
  wrap(cipher: ConsoleCipher): ConsoleCipher;
}

export function keyGuard(
  ensure: () => Promise<string | undefined | unknown>,
  warning: (error: unknown) => string,
  options: { retry?: 'until-done' | 'once' } = {},
): KeyGuard {
  let done = false;
  let retried = false;
  let pending: Promise<void> | undefined;
  const attempt = async (log?: Parameters<KeyGuard['boot']>[0]): Promise<boolean> => {
    try {
      const info = await ensure();
      if (typeof info === 'string') log?.info?.(info);
      done = true;
    } catch (error) {
      log?.warn(warning(error));
    }
    return done;
  };
  const ready = async () => {
    if (done || (options.retry === 'once' && retried)) return;
    pending ??= attempt().then(() => {
      retried = true;
      pending = undefined;
    });
    await pending;
  };
  return {
    boot: (log) => attempt(log),
    wrap: (cipher) => ({
      encrypt: async (input) => {
        await ready();
        return cipher.encrypt(input);
      },
      decrypt: async (input) => {
        await ready();
        return cipher.decrypt(input);
      },
    }),
  };
}

/** A {@link keyGuard} for the console key of `partition` in an embedded crypto service. */
export function embeddedKeyGuard(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): KeyGuard {
  return keyGuard(
    async () =>
      (await ensureConsoleKey(service, partition, key)) === 'created'
        ? `[${PACKAGE}] console commands: created the crypto key "${key}" in partition ${partition}`
        : undefined,
    (error) =>
      `[${PACKAGE}] console commands: could not create the crypto key "${key}" of "${partition}" (${messageOf(error)}). Run \`${createKeyCommand(key, partition)}\`; retried on the next command.`,
  );
}

/**
 * The console side's cipher for the app partition `partition`. Crypto embedded in this app (the
 * Hub): an encrypt-only principal of the service. A tenant of a crypto server: this app's crypto
 * channel, asking the server to encrypt with `partition`'s key (`crypto:seal:console-*`).
 */
export function consoleSealCipher(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): ConsoleCipher {
  const decrypt = async (): Promise<never> => {
    throw new Error(`[${PACKAGE}] the console side never decrypts console commands`);
  };
  const service = runtime.service;
  if (service) {
    const principal = { partition, capabilities: [`crypto:encrypt:${key}`], actor: ACTOR };
    return { encrypt: (input) => service.encrypt(principal, input), decrypt };
  }
  return {
    async encrypt(input) {
      try {
        return await runtime.operations.encrypt({ ...input, partition });
      } catch (error) {
        throw new Error(
          `the crypto server did not seal with the key "${key}" of "${partition}": ${messageOf(error)}. This app's crypto client needs crypto:seal:console-* (or crypto:seal:${key}); a crypto server without cross-partition sealing refuses too: upgrade @adonis-agora/crypto there, or set controlPlane.crypto explicitly`,
        );
      }
    },
    decrypt,
  };
}

// ── The owning app's side ───────────────────────────────────────────────────

/** `consoleCommands`, as far as authentication goes. */
export interface AppConsoleAuthInput {
  secret?: ChannelSecret | undefined;
  /** `false` turns the automatic crypto mode off. */
  crypto?: ConsoleCryptoOption | false | undefined;
  /** `false` turns the automatic verifiers off (a control plane's own, authkit's app calls). */
  verifyTenant?: TenantVerifierOption | false | undefined;
}

/** How the owning app accepts console commands. */
export interface AppConsoleAuth {
  /** One entry per accepted mode, for the boot log and the doctor. */
  modes: string[];
  secret?: ChannelSecret | undefined;
  crypto?: ConsoleCryptoOption | undefined;
  /** Set in the automatic crypto mode: the runtime and key to make sure of. */
  autoCrypto?: { runtime: CryptoRuntimeLike; key: string } | undefined;
  /** The verifier of token mode: explicit, else a control plane's own and/or authkit's app calls. */
  verifyTenant?: TenantVerifierOption | undefined;
  /** Whether a crypto-sealed command must carry a token (only with an explicit `verifyTenant`). */
  cryptoTokenRequired: boolean;
  /** Token mode sealed to the APP_KEY-derived key (no explicit crypto). */
  appKeySealed: boolean;
  /** Set when no mode resolves: the boot fails with it. */
  error?: string | undefined;
}

/** Thrown at boot (web only) when one side of the console channel cannot authenticate. */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

/** Where every boot error points. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/flags/federated-console#authenticating-the-console';

const DOCTOR = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

const cryptoMode = (key: string | undefined, auto: boolean) =>
  `crypto (${auto ? 'auto, ' : ''}key ${key ?? CONSOLE_CRYPTO_KEY})`;

/** The app side's boot error (§11), with what turned the automatic modes off, if anything. */
export function appAuthError(notes: string[] = []): string {
  return `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it ${LIB_NAME}:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR} Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`;
}

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** The console side's boot error (§11) for the `apps` entry `key`. */
export function consoleAuthError(key: string, notes: string[] = []): string {
  const entry = `flags_dashboard.apps["${key}"]`;
  return `[${PACKAGE}] ${entry}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}.controlPlane.secret, or ${entry}.controlPlane.token — or actions: false to only browse it. ${DOCTOR}${notesOf(notes)}`;
}

/** A public key's short id (its `kid`), never its material. */
export function publicKeyId(publicKey: unknown): string | undefined {
  let value = publicKey;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const kid = (value as { kid?: unknown } | null)?.kid;
  return typeof kid === 'string' && kid !== '' ? kid.slice(0, 8) : undefined;
}

/** Decide how the owning app authenticates console commands. Nothing is created here. */
export function resolveAppConsoleAuth(input: {
  option: AppConsoleAuthInput;
  /** A control plane's own `verifyTenant` (already a function): the fallback of token mode. */
  fallbackVerifyTenant?: TenantVerifier | undefined;
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
  /** Whether the app has an APP_KEY of 16+ characters (token mode seals to a key derived from it). */
  hasAppKey: boolean;
  /** The short id of the APP_KEY-derived command key (for the token mode's label). */
  tokenKeyId?: string | undefined;
}): AppConsoleAuth {
  const { option } = input;
  const explicitCrypto = option.crypto ? option.crypto : undefined;
  const explicitVerify = option.verifyTenant ? option.verifyTenant : undefined;
  const explicit =
    explicitCrypto !== undefined || option.secret !== undefined || explicitVerify !== undefined;
  const modes: string[] = [];
  const auth: AppConsoleAuth = { modes, cryptoTokenRequired: false, appKeySealed: false };

  // Token verification: explicit, else every sibling verifier this app has.
  let verifyTenant: TenantVerifierOption | undefined = explicitVerify;
  const sources: string[] = explicitVerify ? ['verifyTenant'] : [];
  if (!verifyTenant && option.verifyTenant !== false) {
    const appCalls = appCallVerifier(input.authkit);
    const found = [appCalls, input.fallbackVerifyTenant].filter(
      (v): v is TenantVerifier => v !== undefined,
    );
    if (found.length > 0) {
      verifyTenant = found.length === 1 ? found[0] : anyVerifier(found);
      if (appCalls) sources.push('authkit app-call, auto');
      if (input.fallbackVerifyTenant) sources.push("the control plane's verifyTenant");
    }
  }

  if (explicitCrypto) {
    auth.crypto = explicitCrypto;
    auth.cryptoTokenRequired = explicitVerify !== undefined;
  } else if (!explicit && option.crypto !== false && input.crypto) {
    const key = CONSOLE_CRYPTO_KEY;
    auth.crypto = { cipher: input.crypto.operations, key };
    auth.autoCrypto = { runtime: input.crypto, key };
  }
  if (auth.crypto) {
    const token = auth.cryptoTokenRequired
      ? ` + token required (${sources.join(', ')})`
      : verifyTenant
        ? ` + token checked when sent (${sources.join(', ')})`
        : '';
    modes.push(cryptoMode(auth.crypto.key, auth.autoCrypto !== undefined) + token);
  }
  if (verifyTenant) auth.verifyTenant = verifyTenant;
  // Also alongside crypto (a migration path): a verifier and an APP_KEY are enough.
  const notes: string[] = [];
  if (verifyTenant) {
    if (input.hasAppKey) {
      auth.appKeySealed = true;
      modes.push(
        `token (${sources.join(', ')}; sealed to key ${input.tokenKeyId ?? 'derived from APP_KEY'})`,
      );
    } else {
      notes.push(
        `a token verifier is available (${sources.join(', ')}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
      );
    }
  }
  if (option.secret !== undefined) {
    auth.secret = option.secret;
    modes.push('secret');
  }
  if (modes.length === 0) {
    if (option.crypto === false) notes.push('`crypto: false` turned the automatic crypto mode off');
    if (option.verifyTenant === false) {
      notes.push('`verifyTenant: false` turned the automatic token verifiers off');
    }
    auth.error = appAuthError(notes);
  }
  return auth;
}

/**
 * §13e (config's rule): whether this app publishes its token key in authkit's directory. Only when
 * token mode is how it is reached: no crypto, or crypto commands that must carry a token too
 * (explicit crypto + verifyTenant, migrating). With crypto enough, nothing is published.
 */
export function publishesTokenKey(
  auth: Pick<AppConsoleAuth, 'appKeySealed' | 'crypto' | 'cryptoTokenRequired'>,
): boolean {
  return auth.appKeySealed && (!auth.crypto || auth.cryptoTokenRequired);
}

// ── The console app's side ──────────────────────────────────────────────────

/** One `apps` entry's `controlPlane`, as far as authentication goes. */
export interface ConsoleSideAuthInput {
  secret?: ChannelSecret | undefined;
  /** `false` turns the automatic token (authkit's app calls) off. */
  token?: TenantTokenSource | false | undefined;
  publicKey?: unknown;
  /** `false` turns the automatic crypto mode off. */
  crypto?: ConsoleCryptoOption | false | undefined;
}

/** How this console authenticates to one app. */
export interface ConsoleSideAuth {
  /** The mode, for the boot log and the doctor (`undefined`: none, browse-only). */
  mode?: string | undefined;
  /** The crypto option to send with (explicit, or automatic). */
  crypto?: ConsoleCryptoOption | undefined;
  /** The token to send (explicit, or authkit's app-call token). */
  token?: TenantTokenSource | undefined;
  /** Set in the automatic crypto mode with crypto embedded: the key to create at boot. */
  ensureKey?: {
    service: NonNullable<CryptoRuntimeLike['service']>;
    partition: string;
    key: string;
  };
  /**
   * Token mode without crypto or `publicKey`: the app's console public key, from authkit's key
   * directory (§2e.B), resolved per command (authkit caches it).
   */
  recipient?: (() => Promise<OkpJwk>) | undefined;
  /**
   * §13a: no explicit mode, and both crypto and authkit's directory are here: the mode is picked per
   * app at the first command (the directory has the app's key → token mode, else crypto), cached
   * for 5 minutes or until the app refuses the mode.
   */
  auto?: { directory: () => Promise<OkpJwk | null>; token: TenantTokenSource } | undefined;
  /** §13b: the token rides along crypto: a token that cannot be minted never blocks a command. */
  tokenOptional?: boolean | undefined;
  /** Set when no mode resolves and the app takes actions: the boot fails with it. */
  error?: string | undefined;
}

/** How long a per-app decision (the mode, a failed token) is kept before it is tried again. */
export const RETRY_AFTER_MS = 5 * 60_000;

/** An app-call token refused because the console's client was not granted the app. */
function missingGrant(reason: string, code: unknown): boolean {
  return code === 'invalid_target' || /invalid_target|not granted|no grant/i.test(reason);
}

/** The hint every app-call token failure ends with. */
export function appCallGrantHint(app: string): string {
  return `To attach it: grant the console's service client flags:console:* on "${app}" in authkit.`;
}

/**
 * §13b: the app-call token as an optional companion of crypto mode. When minting fails, the command
 * goes crypto-only (an empty token), the warning is logged once per reason, and minting is retried
 * after 5 minutes. `failed(reason)` records a failure seen elsewhere (§13a: the token mode's own
 * mint) the same way, so the crypto command that follows does not mint again.
 */
export function optionalAppCallToken(
  source: TenantTokenSource,
  app: string,
  warn: (line: string) => void,
  now: () => number = Date.now,
  /** Where a missing grant is said (`info`): the console was simply not granted that app. */
  info: (line: string) => void = warn,
): { get(): Promise<string>; invalidate(): void; failed(reason: string, code?: unknown): void } {
  const resolved = resolveTenantToken(source);
  let retryAt = 0;
  const warned = new Set<string>();
  const failed = (reason: string, code?: unknown) => {
    retryAt = now() + RETRY_AFTER_MS;
    if (warned.has(reason)) return;
    if (warned.size < 100) warned.add(reason);
    try {
      const line = `[${PACKAGE}] console commands to "${app}": sending without an authkit app-call token (crypto only): ${reason}. ${appCallGrantHint(app)}`;
      // A missing grant is a choice, not a fault (info); anything else is a warning.
      if (missingGrant(reason, code)) info(line);
      else warn(line);
    } catch {
      // a logger that throws must not block the command
    }
  };
  return {
    async get() {
      if (now() < retryAt) return '';
      try {
        return await resolved.get();
      } catch (error) {
        failed(messageOf(error), codeOf(error));
        return '';
      }
    },
    invalidate: () => resolved.invalidate?.(),
    failed,
  };
}

/** The app-call token where it is required (token mode): a failure says what to grant. */
export function requiredAppCallToken(
  source: TenantTokenSource,
  app: string,
): { get(): Promise<string>; invalidate(): void } {
  const resolved = resolveTenantToken(source);
  return {
    async get() {
      try {
        return await resolved.get();
      } catch (error) {
        // `reason`: the bare cause, for the §13b warning when crypto takes over (§13a).
        throw Object.assign(new Error(`${messageOf(error)}. ${appCallGrantHint(app)}`), {
          reason: messageOf(error),
          // The bare cause's code (`invalid_target` is a missing grant: info, §13b).
          ...(codeOf(error) !== undefined ? { reasonCode: codeOf(error) } : {}),
        });
      }
    },
    invalidate: () => resolved.invalidate?.(),
  };
}

/** The purpose this lib's console public keys are published under in authkit's key directory. */
export const CONSOLE_KEY_PURPOSE = 'console:flags';

/** The actionable error when the directory has no key for `app`. */
export function directoryKeyMissing(app: string): string {
  return `[${PACKAGE}] the app "${app}" has no console public key in authkit's key directory (purpose ${CONSOLE_KEY_PURPOSE}): it publishes it automatically at boot when it has authkit's \`service\` configured, an APP_KEY and a token verifier (token mode). Or set controlPlane.publicKey (what \`node ace flags:console-key\` prints in that app).`;
}

/** The app's console public key from authkit's directory, or an actionable error. */
function directoryRecipient(
  authkit: AuthkitClientLike | undefined,
  app: string,
): (() => Promise<OkpJwk>) | undefined {
  if (typeof authkit?.appKey !== 'function') return undefined;
  const lookup = authkit.appKey.bind(authkit);
  return async () => {
    const jwk = await lookup({ app, purpose: CONSOLE_KEY_PURPOSE });
    if (!jwk) throw new Error(directoryKeyMissing(app));
    return jwk;
  };
}

/** A public JWK without its private half, for publishing (never `d`). */
export function publicHalf(jwk: OkpJwk): OkpJwk {
  const { d: _d, ...rest } = jwk as OkpJwk & { d?: unknown };
  return rest as OkpJwk;
}

export function resolveConsoleSideAuth(input: {
  key: string;
  partition: string;
  plane: ConsoleSideAuthInput;
  actions: boolean;
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
}): ConsoleSideAuth {
  const { plane, partition } = input;
  const explicitCrypto = plane.crypto ? plane.crypto : undefined;
  const explicitToken = plane.token ? plane.token : undefined;
  const explicit =
    explicitCrypto !== undefined || explicitToken !== undefined || plane.secret !== undefined;
  const auth: ConsoleSideAuth = {};
  const notes: string[] = [];
  let cryptoLabel: string | undefined;

  if (explicitCrypto) {
    auth.crypto = explicitCrypto;
    cryptoLabel = cryptoMode(explicitCrypto.key, false);
  } else if (!explicit && plane.crypto !== false && input.crypto) {
    const key = CONSOLE_CRYPTO_KEY;
    auth.crypto = { cipher: consoleSealCipher(input.crypto, partition, key), key };
    if (input.crypto.service) auth.ensureKey = { service: input.crypto.service, partition, key };
    cryptoLabel = `crypto (auto, key ${key}, partition ${partition})`;
  }

  // A token travels sealed: with crypto, to the configured public key (it wins), or to the key
  // the app published in authkit's directory.
  const directory =
    !auth.crypto && plane.publicKey === undefined
      ? directoryRecipient(input.authkit, partition)
      : undefined;
  const sealable = auth.crypto !== undefined || plane.publicKey !== undefined || !!directory;
  const unsealed =
    "a token must travel sealed: set controlPlane.publicKey (`node ace flags:console-key` in that app; the app also publishes it in authkit's key directory when it has authkit's `service` configured) or boot @adonis-agora/crypto";
  let tokenSource: string | undefined;
  if (explicitToken) {
    if (sealable) {
      auth.token = explicitToken;
      tokenSource = 'controlPlane.token';
    } else notes.push(unsealed);
  } else if (plane.token !== false && plane.secret === undefined) {
    const token = appCallTokenSource(input.authkit, partition);
    if (token && sealable) {
      auth.token = token;
      tokenSource = 'authkit app-call, auto';
    } else if (token) notes.push(unsealed);
  }
  if (auth.token && directory) auth.recipient = directory;
  // §13b: the automatic app-call token next to crypto is optional.
  if (auth.crypto && tokenSource === 'authkit app-call, auto') auth.tokenOptional = true;

  // §13a: both crypto (automatic) and authkit's directory: pick per app at the first command.
  if (
    cryptoLabel?.startsWith('crypto (auto') &&
    auth.token &&
    tokenSource === 'authkit app-call, auto' &&
    plane.publicKey === undefined &&
    typeof input.authkit?.appKey === 'function'
  ) {
    const lookup = input.authkit.appKey.bind(input.authkit);
    auth.auto = {
      directory: async () => {
        try {
          return await lookup({ app: partition, purpose: CONSOLE_KEY_PURPOSE });
        } catch {
          return null;
        }
      },
      token: auth.token,
    };
    auth.mode = `auto (authkit key directory if the app publishes one, else ${cryptoLabel})`;
    return auth;
  }

  const parts: string[] = [];
  if (cryptoLabel) parts.push(cryptoLabel + (tokenSource ? ` + token (${tokenSource})` : ''));
  else if (tokenSource) {
    // The key's source goes inside the parentheses; its short id after `sealed to key`.
    parts.push(
      auth.recipient
        ? `token (${tokenSource}, authkit key directory; sealed to the key the app publishes)`
        : `token (${tokenSource}, controlPlane.publicKey; sealed to key ${publicKeyId(plane.publicKey) ?? 'unknown'})`,
    );
  }
  if (plane.secret !== undefined) parts.push('secret');
  if (parts.length > 0) {
    auth.mode = parts.join(' + ');
    return auth;
  }
  if (!input.actions) return auth;
  if (plane.crypto === false) notes.push('`crypto: false` turned the automatic crypto mode off');
  if (plane.token === false) notes.push('`token: false` turned the automatic authkit token off');
  auth.error = consoleAuthError(input.key, notes);
  return auth;
}

/**
 * Round-trip a probe through `encrypt`/`decrypt` with `key` (the doctor's deep check). Never
 * returns the probe or the ciphertext.
 */
export async function probeCipher(
  encrypt: ConsoleCipher['encrypt'],
  decrypt: ConsoleCipher['decrypt'],
  key: string,
): Promise<void> {
  const plaintext = `agora:doctor:${Date.now()}`;
  const aad = 'agora:doctor:console-commands';
  const { ciphertext } = await encrypt({ key, plaintext, aad, context: aad });
  const opened = await decrypt({ key, ciphertext, aad, context: aad });
  if (opened.plaintext !== plaintext) throw new Error('the probe did not round-trip');
}
