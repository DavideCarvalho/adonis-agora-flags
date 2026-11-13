/**
 * Pure helpers for mounting/serving the `@adonis-agora/flags-dashboard` React SPA — split out so
 * they're unit-testable without booting AdonisJS. `providers/dashboard_provider.ts` is a thin HTTP
 * shell around these. Same shape as the payments and durable consoles' `spa.ts`, so "serve a Vite
 * SPA from an AdonisJS provider" stays ONE pattern across the Agora ecosystem.
 */

import type { ConsoleSignOut, ConsoleViewer } from './console_shell.js';

/** Placeholder base Vite bakes into asset URLs (`packages/dashboard/vite.config.ts`); rewritten to the
 *  configured dashboard `path` at serve time — the SAME built bundle mounts at any path with no rebuild. */
export const BASE_PLACEHOLDER = '/__FLAGS_DASHBOARD__/';

export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Content type for a served asset filename, defaulting to octet-stream. */
export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** `id` of the JSON data block `renderIndexHtml` injects; `src/client/flags-client.ts` reads it. */
export const CONFIG_ELEMENT_ID = 'flags-dashboard-config';

/** What the page tells the SPA about the deployment it is mounted in. */
export interface InjectedConfig {
  /** UI mount base (`/flags`; `''` for a root mount). */
  base: string;
  /** JSON API base (`/flags/api`). */
  api: string;
  /** The environment this app evaluates (the default selection of the environment switcher). */
  environment: string;
  /** The console switcher, present only when other Agora consoles are registered in the app. */
  switcher?: SwitcherConfig;
  /** ⌘K search across the consoles (`GET <endpoint>?q=`), present when a registry exists. */
  search?: { endpoint: string };
  /** Who is signed in (sidebar footer). Absent → no user row. */
  viewer?: ConsoleViewer;
  /** How the footer signs out. Absent → no sign-out control. */
  signOut?: ConsoleSignOut;
}

/** Where the SPA asks which other consoles the viewer may open, and how many are registered. */
export interface SwitcherConfig {
  /** `GET` it for the consoles the viewer may open; `<endpoint>/search?q=` searches them. */
  endpoint: string;
  /** Registered consoles other than this one (before any `authorize` runs). */
  others: number;
}

/** The console-shell fields of the data block (switcher, ⌘K search, viewer, sign-out). */
export interface ShellFields {
  switcher?: SwitcherConfig;
  search?: { endpoint: string };
  viewer?: ConsoleViewer;
  signOut?: ConsoleSignOut;
}

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at the configured mount
 * path, and hand the SPA its deployment config.
 *
 * The config goes in as a JSON DATA BLOCK (`<script type="application/json">`), not as an inline
 * script assigning globals. A data block is never executed, so no Content-Security-Policy can refuse
 * it; an inline script IS, and a host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
 * `@nonce`) silently drops it — the console then renders and every API call 404s.
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  apiBasePath: string,
  environment: string,
  extra: ShellFields = {},
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  const config: InjectedConfig = {
    base: basePath,
    api: apiBasePath,
    environment,
    ...(extra.switcher && extra.switcher.others > 0 ? { switcher: extra.switcher } : {}),
    ...(extra.search ? { search: extra.search } : {}),
    ...(extra.viewer ? { viewer: extra.viewer } : {}),
    ...(extra.signOut ? { signOut: extra.signOut } : {}),
  };
  // `<` escaped as `<` inside the JSON: a data block ends at the first `</script`, and a
  // config value must not be able to close it early. Valid JSON either way.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const inject = `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}
