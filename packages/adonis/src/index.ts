export const VERSION = '0.0.0';

export type {
  EvaluationContext,
  EvaluationDetails,
  FlagDefinition,
  JsonValue,
  Ruleset,
  Segment,
} from '@adonis-agora/flags-core';
export {
  type AdminAction,
  type AdminAuthorizer,
  type ApprovalsConfig,
  checkAgainstDeclarations,
  definitionFromDeclaration,
  FlagsAdmin,
  ForbiddenError,
  type ProposeResult,
  type StaleFlag,
  ValidationError,
} from './admin.js';
export type { AnalyticsBackend } from './analytics/backend.js';
export { ClickHouseBackend } from './analytics/clickhouse_backend.js';
export { DuckDbBackend } from './analytics/duckdb.js';
export { LucidBackend } from './analytics/lucid_backend.js';
export { type MetricDefinition, type MetricKind, metric } from './analytics/metrics.js';
export {
  type Comparison,
  computeResults,
  type ExperimentResults,
  type MetricResult,
} from './analytics/results.js';
export {
  type FlagDeclaration,
  type FlagMeta,
  type FlagType,
  flag,
  type InferFlags,
} from './declare.js';
export {
  analytics,
  type ControlPlaneConfig,
  defineConfig,
  type ExperimentConfig,
  type FactoryContext,
  type FlagsConfig,
  type StandaloneConfig,
  sinks,
  stores,
  type TenantConfig,
  transports,
} from './define_config.js';
export { DIAGNOSTICS_CHANNELS, type Enricher, enrichers } from './enrichers.js';
export { EVENT_SCHEMA_VERSION, exposureId, type FlagEvent, uuidv7 } from './events/event.js';
export { FlagsManager, FlagsScope, type TrackOptions } from './manager.js';
export { Relay } from './relay/relay.js';
export { FlagsWorker } from './relay/worker.js';
export { createRuntime, type FlagsRuntime, lucidContext } from './runtime.js';
export {
  createFlagsTables,
  dropFlagsTables,
  ensureEventPartitions,
  FLAGS_TABLES,
  pruneEvents,
} from './schema.js';
export { ClickHouseSink } from './sinks/clickhouse.js';
export { LucidSink } from './sinks/lucid_sink.js';
export { ParquetSink } from './sinks/parquet_sink.js';
export { PostHogSink } from './sinks/posthog_sink.js';
export { CallbackSink, MemorySink, type Sink } from './sinks/sink.js';
export { LucidStore, RULESET_CHANNEL } from './stores/lucid_store.js';
export { MemoryStore } from './stores/memory_store.js';
export type {
  Actor,
  AuditEntry,
  ChangeRequest,
  FlagsStore,
  RulesetChange,
  ScheduledChange,
} from './stores/store.js';
export type { Subject, SubjectLike } from './subject.js';
export { TENANT_SCOPES, type TokenSource, tokens } from './topology/token.js';
export { type TenantVerifier, type VerifiedTenant, verifiers } from './topology/verify.js';
export { DbTransport } from './transports/db_transport.js';
export { MemoryTransport } from './transports/memory_transport.js';
export { RedisTransport } from './transports/redis_transport.js';
export type { Transport } from './transports/transport.js';
export type { BooleanFlagKey, FlagKey, FlagsList, FlagValue } from './types.js';
