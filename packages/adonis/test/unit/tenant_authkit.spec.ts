import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, type FlagsConfig } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/index.js';
import { tenantTransports } from '../../src/tenant_transports/index.js';
import {
  describeTenantSources,
  resolveTenantFields,
  TenantConfigError,
} from '../../src/topology/authkit_tenant.js';

/** A fake `'authkit.client'` binding with `tenantOf` (authkit-client's contract, structurally). */
function fakeAuthkit(url = 'http://cp.example/_flags', calls: string[] = []) {
  const urlFn = Object.assign(async () => url, { refresh: async () => url });
  const tokenFn = Object.assign(async () => 'auto-token', { reset() {} });
  return {
    calls,
    tenantOf(resource: string) {
      calls.push(resource);
      return { url: urlFn, token: tokenFn, partition: 'shop-auto' };
    },
  };
}

function containerWith(binding?: unknown) {
  return {
    hasBinding: (name: string) => name === 'authkit.client' && binding !== undefined,
    make: async () => binding,
  };
}

describe('tenant fields from authkit-client (tenantOf)', () => {
  it('fills url, token and partition from a fake authkit.client binding', async () => {
    const authkit = fakeAuthkit();
    const { tenant, sources } = await resolveTenantFields(undefined, {
      container: containerWith(authkit),
    });
    expect(authkit.calls).toEqual(['urn:agora:flags']);
    expect(await (tenant.url as () => Promise<string>)()).toBe('http://cp.example/_flags');
    expect(await (tenant.token as () => Promise<string>)()).toBe('auto-token');
    expect(tenant.partition).toBe('shop-auto');
    expect(sources).toEqual({ url: 'auto', token: 'auto', partition: 'auto' });
    expect(describeTenantSources(sources)).toBe(
      'tenant url: authkit-client (auto), token: authkit-client (auto), partition: authkit-client (auto)',
    );
  });

  it('lets each explicit field win', async () => {
    const { tenant, sources } = await resolveTenantFields(
      { partition: 'streaming', snapshotPath: 'storage/x.json' } as never,
      { container: containerWith(fakeAuthkit()) },
    );
    expect(tenant.partition).toBe('streaming');
    expect((tenant as { snapshotPath?: string }).snapshotPath).toBe('storage/x.json');
    expect(sources).toEqual({ url: 'auto', token: 'auto', partition: 'explicit' });
    expect(describeTenantSources(sources)).toBe(
      'tenant url: authkit-client (auto), token: authkit-client (auto), partition: explicit',
    );

    const token = await resolveTenantFields(
      { url: 'http://mine', token: 'secret' },
      { container: containerWith(fakeAuthkit()) },
    );
    expect(token.tenant).toMatchObject({
      url: 'http://mine',
      token: 'secret',
      partition: 'shop-auto',
    });
    expect(token.sources).toEqual({ url: 'explicit', token: 'explicit', partition: 'auto' });
  });

  it('does not call tenantOf when everything is explicit', async () => {
    const authkit = fakeAuthkit();
    const { sources } = await resolveTenantFields(
      { url: 'http://cp', token: 't', partition: 'p' },
      { container: containerWith(authkit) },
    );
    expect(authkit.calls).toEqual([]);
    expect(sources).toEqual({ url: 'explicit', token: 'explicit', partition: 'explicit' });
  });

  it('names the missing fields and both fixes without a binding', async () => {
    const error = await resolveTenantFields({}, { container: containerWith() }).catch((e) => e);
    expect(error).toBeInstanceOf(TenantConfigError);
    expect(error.message).toBe(
      "[@adonis-agora/flags] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. Configure @adonis-agora/authkit-client's `service` (config/authkit.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/flags.ts.",
    );
    await expect(
      resolveTenantFields({ url: 'http://cp' }, { container: containerWith() }),
    ).rejects.toThrow(/needs tenant\.token, tenant\.partition\./);
  });

  it('treats a binding without tenantOf (an older authkit-client) as absent', async () => {
    const older = { appCallTokens: () => undefined };
    await expect(resolveTenantFields({}, { container: containerWith(older) })).rejects.toThrow(
      TenantConfigError,
    );
  });

  it('ignores the binding with tenant.auto: false', async () => {
    const authkit = fakeAuthkit();
    await expect(
      resolveTenantFields({ auto: false, url: 'http://cp' }, { container: containerWith(authkit) }),
    ).rejects.toThrow(/needs tenant\.token, tenant\.partition/);
    expect(authkit.calls).toEqual([]);
  });

  it("surfaces tenantOf's own error (authkit-client without `service`)", async () => {
    const authkit = {
      tenantOf() {
        throw new Error('authkit-client: tenantOf needs `service` in config/authkit.ts');
      },
    };
    await expect(resolveTenantFields({}, { container: containerWith(authkit) })).rejects.toThrow(
      /needs tenant\.url, tenant\.token, tenant\.partition \(authkit-client: authkit-client: tenantOf needs `service`/,
    );
  });

  it('needs no url on a broker-only tenant', async () => {
    const { tenant, sources } = await resolveTenantFields(
      { token: 't', partition: 'p', transport: tenantTransports.redis() } as never,
      { container: containerWith() },
    );
    expect(tenant.partition).toBe('p');
    expect(sources.url).toBe('none');
  });

  it('defineConfig accepts the one-line tenant, and checks fields up front with auto: false', () => {
    expect(() => defineConfig({ topology: 'tenant', flags: {} })).not.toThrow();
    expect(() =>
      defineConfig({ topology: 'tenant', flags: {}, tenant: { auto: false, url: 'http://cp' } }),
    ).toThrow(/needs tenant\.token, tenant\.partition/);
  });
});

describe('a booted tenant app with authkit-client', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function controlPlane() {
    const seen: { auth?: string; tenant?: string } = {};
    const server: Server = createServer((req, res) => {
      if (req.url?.endsWith('/v1/ruleset')) {
        seen.auth = req.headers.authorization;
        seen.tenant = req.headers['x-flags-tenant'] as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '1', flags: {} }));
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`, seen };
  }

  async function boot(
    environment: 'console' | 'web',
    flags: FlagsConfig,
    authkit: unknown | undefined,
  ): Promise<ApplicationService> {
    const providers: Array<() => Promise<{ default: unknown }>> = [];
    if (authkit) {
      providers.push(async () => ({
        default: class {
          constructor(protected app: ApplicationService) {}
          register() {
            this.app.container.singleton('authkit.client' as never, () => authkit as never);
          }
        },
      }));
    }
    providers.push(() => import('../../providers/flags_provider.js'));
    const ignitor = new IgnitorFactory()
      .merge({ rcFileContents: { providers }, config: { flags } })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    const app = ignitor.createApp(environment) as ApplicationService;
    await app.init();
    cleanups.push(async () => {
      await app.terminate();
    });
    await app.boot();
    return app;
  }

  it('connects with url, token and partition from tenantOf; the doctor says so', async () => {
    const plane = await controlPlane();
    const app = await boot(
      'console',
      defineConfig({ topology: 'tenant', flags: {} }),
      fakeAuthkit(plane.base),
    );
    const runtime = (await app.container.make('flags.runtime')) as unknown as {
      manager: { app: string };
    };
    expect(runtime.manager.app).toBe('shop-auto');
    expect(plane.seen.auth).toBe('Bearer auto-token');
    const check = agoraDoctorChecks.find((c) => c.id === 'flags.tenant-source')!;
    expect(await check.run(app)).toEqual({
      status: 'ok',
      message:
        'tenant url: authkit-client (auto), token: authkit-client (auto), partition: authkit-client (auto).',
    });
  });

  it('registers its checks in the agora:doctor registry, even when the tenant cannot build', async () => {
    const app = await boot('console', defineConfig({ topology: 'tenant', flags: {} }), undefined);
    const registry = (await app.container.make('agora.doctor' as never)) as {
      version: number;
      checks: Array<{ id: string }>;
    };
    expect(registry.version).toBe(1);
    expect(registry.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['flags.tenant-source', 'flags.tenant-transport']),
    );
  });

  it('a web server without authkit-client refuses to boot, naming the fields', async () => {
    await expect(
      boot('web', defineConfig({ topology: 'tenant', flags: {} }), undefined),
    ).rejects.toThrow(/topology 'tenant' needs tenant\.url, tenant\.token, tenant\.partition\./);
  });

  it('an ace process only logs it; the doctor reports it', async () => {
    const app = await boot('console', defineConfig({ topology: 'tenant', flags: {} }), undefined);
    await expect(app.container.make('flags.manager')).rejects.toThrow(TenantConfigError);
    const check = agoraDoctorChecks.find((c) => c.id === 'flags.tenant-source')!;
    const result = (await check.run(app)) as { status: string; message: string };
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/needs tenant\.url, tenant\.token, tenant\.partition/);
  });
});
