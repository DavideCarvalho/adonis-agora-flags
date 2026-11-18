import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type FlagRow } from '../client/flags-client';

/** Comma-separated text ↔ list, for the fields that keep tags as text. */
export const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** The tags and owners in use across the flags, sorted (the options of tag/owner fields). */
export function flagFacets(flags: readonly FlagRow[]): { tags: string[]; owners: string[] } {
  return {
    tags: [...new Set(flags.flatMap((f) => f.tags))].sort(),
    owners: [...new Set(flags.map((f) => f.owner).filter((o): o is string => o !== null))].sort(),
  };
}

/** The flag list of the environment, under the same query key as the Flags screen (one fetch). */
export function useFlagRows(environment: string, enabled = true) {
  return useQuery({
    queryKey: ['flags', environment],
    queryFn: () => api.flags(environment),
    enabled,
  });
}

/** Tags, owners and keys in use, for autocomplete. Empty while loading. */
export function useFlagFacets(environment: string) {
  const query = useFlagRows(environment);
  const flags = query.data?.data;
  const facets = useMemo(() => flagFacets(flags ?? []), [flags]);
  return { ...facets, loading: query.isPending };
}

type AuditEntity = '' | 'flag' | 'segment' | 'layer' | 'metric' | 'holdout' | 'ruleset';

/**
 * The keys of the audit entity picked (flags for "all"), from the queries the matching screens
 * already make. Holdout and imports have no catalog: the field stays free text.
 */
export function useEntityKeys(environment: string, entity: AuditEntity) {
  const flags = useFlagRows(environment, entity === '' || entity === 'flag');
  const segments = useQuery({
    queryKey: ['segments', environment],
    queryFn: () => api.segments(environment),
    enabled: entity === 'segment',
  });
  const layers = useQuery({
    queryKey: ['layers', environment],
    queryFn: () => api.layers(environment),
    enabled: entity === 'layer',
  });
  const metrics = useQuery({
    queryKey: ['metrics', environment],
    queryFn: () => api.metrics(environment),
    enabled: entity === 'metric',
  });
  const keys = useMemo(() => {
    const list =
      entity === '' || entity === 'flag'
        ? flags.data?.data.map((f) => f.key)
        : entity === 'segment'
          ? segments.data?.data.map((s) => s.key)
          : entity === 'layer'
            ? layers.data?.data.map((l) => l.key)
            : entity === 'metric'
              ? metrics.data?.data.map((m) => m.name)
              : [];
    return [...new Set(list ?? [])].sort();
  }, [entity, flags.data, segments.data, layers.data, metrics.data]);
  const active =
    entity === '' || entity === 'flag'
      ? flags
      : entity === 'segment'
        ? segments
        : entity === 'layer'
          ? layers
          : entity === 'metric'
            ? metrics
            : null;
  return { keys, loading: active?.isPending ?? false };
}
