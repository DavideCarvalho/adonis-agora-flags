import type { ApplicationService } from '@adonisjs/core/types';
import type { FlagsRuntime } from '../runtime.js';

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

const DOCS = 'https://davidecarvalho.github.io/agora/docs/flags/central-server#transports';

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
];
