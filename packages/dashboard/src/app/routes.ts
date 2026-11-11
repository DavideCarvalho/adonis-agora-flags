/**
 * The console's URL scheme — a hash route, parsed and formatted in one place.
 *
 * `#/<screen>[/<id>][?env=<environment>]`, for example:
 *
 * - `#/flags`                       — the flag list in the app's own environment
 * - `#/flags/checkout_v2?env=staging` — one flag's editor, in staging
 * - `#/experiments/checkout_v2`     — one experiment's results
 *
 * A hash, not a path: the provider registers `GET <path>` as an EXACT route (no SPA catch-all), so
 * `<path>/flags` would 404 on reload. The fragment never reaches the server and works at any mount.
 * The environment travels in the hash too, so a link pasted into a ticket opens the same
 * environment the sender was looking at — editing production by accident is the failure to avoid.
 *
 * Anything unrecognised parses to the flag list, never to an error.
 */

export type Screen =
  | 'flags'
  | 'segments'
  | 'layers'
  | 'experiments'
  | 'approvals'
  | 'activity'
  | 'environments'
  | 'hygiene'
  | 'ops';

export const SCREENS: ReadonlyArray<{ value: Screen; label: string }> = [
  { value: 'flags', label: 'Flags' },
  { value: 'segments', label: 'Segments' },
  { value: 'layers', label: 'Layers' },
  { value: 'experiments', label: 'Experiments' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'activity', label: 'Activity' },
  { value: 'environments', label: 'Environments' },
  { value: 'hygiene', label: 'Hygiene' },
  { value: 'ops', label: 'Ops' },
];

const SCREEN_VALUES = new Set<string>(SCREENS.map((screen) => screen.value));

/** Screens whose second segment names something (a flag key, an experiment key). */
const WITH_ID = new Set<Screen>(['flags', 'experiments']);

export function isScreen(value: string): value is Screen {
  return SCREEN_VALUES.has(value);
}

export interface Route {
  screen: Screen;
  /** The flag (or experiment) open in the detail view. */
  id?: string | undefined;
  /** The environment being looked at; absent = the app's own. */
  env?: string | undefined;
}

/** Parse `window.location.hash` (with or without the leading `#`) into a {@link Route}. */
export function parseRoute(hash: string): Route {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryAt = trimmed.indexOf('?');
  const path = queryAt === -1 ? trimmed : trimmed.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? '' : trimmed.slice(queryAt + 1));
  const env = query.get('env');
  const withEnv = (route: Route): Route => (env !== null && env !== '' ? { ...route, env } : route);

  if (!path.startsWith('/')) return withEnv({ screen: 'flags' });
  const slash = path.indexOf('/', 1);
  const screen = slash === -1 ? path.slice(1) : path.slice(1, slash);
  const id = slash === -1 ? '' : path.slice(slash + 1);
  if (!isScreen(screen)) return withEnv({ screen: 'flags' });
  const route: Route = { screen };
  if (WITH_ID.has(screen) && id !== '') route.id = safeDecode(id);
  return withEnv(route);
}

/** Format a {@link Route} as the hash to assign (leading `#` included). */
export function formatRoute(route: Route): string {
  let hash = `#/${route.screen}`;
  if (WITH_ID.has(route.screen) && route.id !== undefined && route.id !== '') {
    hash += `/${encodeURIComponent(route.id)}`;
  }
  if (route.env !== undefined && route.env !== '') {
    hash += `?${new URLSearchParams({ env: route.env }).toString()}`;
  }
  return hash;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
