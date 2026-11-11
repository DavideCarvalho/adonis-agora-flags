import type { HttpContext } from '@adonisjs/core/http';
import type { BrowserConfig } from '../define_config.js';
import type { FlagsRuntime } from '../runtime.js';
import { toSubject } from '../subject.js';
import {
  type BrowserKeySource,
  type IssuedBrowserToken,
  signBrowserToken,
} from '../topology/browser_token.js';
import { defaultSubject } from './subject_resolver.js';

export interface BrowserTokenResponse extends IssuedBrowserToken {
  /** The flags API the token is for. */
  url: string;
}

/**
 * Issues browser tokens for the request's subject — the same one `ctx.flags` uses: the authkit
 * identity when `@adonis-agora/authkit-client` is installed, else your `subject` resolver, else
 * `ctx.auth.user`, else an anonymous visitor (static values only). The `attributes` resolver of
 * `config/flags.ts` runs too, so server-side attributes travel signed with the token.
 */
export class BrowserTokens {
  constructor(
    private readonly runtime: FlagsRuntime,
    private readonly keys: BrowserKeySource,
    private readonly url: string,
    private readonly config: BrowserConfig,
    private readonly logger?: { warn(message: string): void },
  ) {}

  async issue(ctx: HttpContext): Promise<BrowserTokenResponse> {
    const resolve = this.runtime.config.subject ?? defaultSubject;
    const subject = toSubject(await resolve(ctx));
    const resolved = await this.runtime.manager.attributesFor(subject);
    const { key, app, environment } = await this.keys.get();
    const issued = signBrowserToken(
      subject && { ...subject, attributes: { ...resolved, ...subject.attributes } },
      {
        key,
        app,
        environment,
        ...(this.config.ttlSeconds !== undefined ? { ttlSeconds: this.config.ttlSeconds } : {}),
      },
    );
    return { ...issued, url: this.url };
  }

  async handle(ctx: HttpContext) {
    try {
      const body = await this.issue(ctx);
      ctx.response.header('cache-control', 'no-store');
      return ctx.response.json(body);
    } catch (error) {
      this.logger?.warn(`[flags] issuing a browser token failed: ${(error as Error).message}`);
      return ctx.response.status(503).send({ error: 'flags unavailable' });
    }
  }
}
