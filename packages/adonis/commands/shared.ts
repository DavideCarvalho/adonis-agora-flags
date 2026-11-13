import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { FlagDefinition } from '@adonis-agora/flags-core';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { ApiRequest, ApiResponse, Deps } from '../src/dashboard/handlers.js';
import type { FlagsRuntime } from '../src/runtime.js';
import type { Actor } from '../src/stores/store.js';

/** Who a command acts as: `cli:<os user>`, unless `--as` says otherwise. */
export function cliActor(as?: string): Actor {
  if (as) return { id: as };
  let name = 'unknown';
  try {
    name = userInfo().username;
  } catch {
    // containers without a passwd entry
  }
  return { id: `cli:${name}` };
}

/** One line on what a flag serves. */
export function describeServing(definition: FlagDefinition | undefined): string {
  if (!definition) return 'not configured (code default)';
  if (!definition.enabled) return `killed → ${definition.offVariant}`;
  const parts: string[] = [];
  const fallthrough = definition.fallthrough;
  if ('variant' in fallthrough) parts.push(`serves ${fallthrough.variant}`);
  else {
    const total = fallthrough.split.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0) || 1;
    parts.push(
      fallthrough.split
        .filter((arm) => arm.weight > 0)
        .map((arm) => `${arm.variant} ${Math.round((arm.weight / total) * 1000) / 10}%`)
        .join(' / '),
    );
  }
  if (definition.rules?.length) parts.push(`${definition.rules.length} rule(s)`);
  const overrides = Object.keys(definition.overrides ?? {}).length;
  if (overrides) parts.push(`${overrides} override(s)`);
  if (definition.experiment) parts.push('experiment');
  return parts.join(', ');
}

/** Base for every flags command: boots the app and hands the runtime over. */
export abstract class FlagsCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  /**
   * A refused change (unknown flag, invalid value, not allowed) is a message, not a stack trace.
   * `@adonisjs/core` hands a command's error to this hook before printing it; returning `true`
   * marks it handled. Programming errors keep their stack.
   */
  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  protected async runtime(): Promise<FlagsRuntime> {
    const runtime = (await this.app.container.make('flags.runtime')) as FlagsRuntime;
    if (runtime.topology === 'tenant') {
      throw new Error('this app is a tenant: run flags commands on the control-plane');
    }
    return runtime;
  }
}

/** A console handler: `(deps, request) → response`. */
type ConsoleHandler = (deps: Deps, req: ApiRequest) => Promise<ApiResponse>;

/** A console answer that is not 2xx, as one line: `422: invalid change: flags.x.variants must …`. */
export function refusal(response: ApiResponse): string {
  const answer = (response.body ?? {}) as { error?: unknown; issues?: unknown };
  const error = typeof answer.error === 'string' ? answer.error : 'refused';
  const issues = Array.isArray(answer.issues)
    ? `: ${answer.issues
        .map((i: { path?: unknown; message?: unknown }) => `${String(i.path)} ${String(i.message)}`)
        .join('; ')}`
    : '';
  return `${response.status}: ${error}${issues}`;
}

/**
 * Parses a JSON argument: inline JSON, or `@path/to/file.json`. Exported for tests.
 */
export async function jsonArgument(value: string, name: string): Promise<unknown> {
  const text = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${name} must be JSON (inline, or @file.json)`);
  }
}

/**
 * Base for the commands that mirror the console: each one runs the console's own JSON handler (the
 * one its API route and its `flags_*` dev tool run), so validation, `authorize`, approvals and the
 * audit trail are the console's. A non-2xx answer becomes one error line and exit code 1.
 */
export abstract class FlagsConsoleCommand extends FlagsCommand {
  @flags.string({ description: 'Environment (default: the configured one)' })
  declare env?: string;

  @flags.string({ description: 'Act as this actor id instead of cli:<user>' })
  declare as?: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  /** Runs `handler` as the console would for this command's actor; the body, or throws. */
  protected async call(
    handler: ConsoleHandler,
    req: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const runtime = await this.runtime();
    const query = { ...(req.query ?? {}) };
    let body = req.body;
    if (this.env !== undefined) {
      if (body !== undefined) body = { environment: this.env, ...(body as object) };
      else query.environment = this.env;
    }
    const response = await handler(
      { runtime, actor: cliActor(this.as) },
      { params: req.params ?? {}, query, ...(body !== undefined ? { body } : {}) },
    );
    if (response.status < 200 || response.status >= 300) throw new Error(refusal(response));
    return (response.body ?? {}) as Record<string, unknown>;
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /** What a write did: applied (and the version), or filed as a change request. */
  protected reportWrite(result: Record<string, unknown>, what: string): void {
    if (this.json) {
      this.printJson(result);
      return;
    }
    if (result.status === 'pending') {
      const request = result.request as { id: string };
      this.logger.warning(`approval required: change request ${request.id} is pending (${what})`);
      return;
    }
    this.logger.success(`${what} (ruleset version ${String(result.version)})`);
  }

  /**
   * Destructive actions ask first. `--force` skips the question; without a terminal (CI, a pipe)
   * there is nobody to ask, so the command refuses unless `--force`.
   */
  protected async confirmed(force: boolean | undefined, question: string): Promise<boolean> {
    if (force) return true;
    if (process.stdin.isTTY !== true) {
      throw new Error(`${question.replace(/\?$/, '')}: needs confirmation, pass --force`);
    }
    if (await this.prompt.confirm(question)) return true;
    this.logger.warning('cancelled');
    this.exitCode = 1;
    return false;
  }
}
