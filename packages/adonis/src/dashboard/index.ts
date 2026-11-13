export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// The built-in "access denied" page (what a browser sees on a refused page navigation).
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
export { defaultActor, FALLBACK_ACTOR, toActor } from './actor.js';
// The dashboard-gate contract shared (by copy) with every @adonis-agora console.
export type {
  AuthorizeDecision,
  AuthorizeResult,
  ResolvedAuthorizeResult,
} from './authorize_decision.js';
export { resolveAuthorizeResult, runAuthorize } from './authorize_decision.js';
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeDecision,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  ActorResolver,
  AuthorizeHook,
  FlagsDashboardConfig,
  ResolvedFlagsDashboardConfig,
} from './define_config.js';
export { defineConfig, resolveConfig } from './define_config.js';
export type {
  DevTool,
  DevToolCall,
  DevToolInputSchema,
  DevToolsCaller,
  DevToolsDecision,
  DevToolsHub,
  DevToolsLib,
  FlagsDevToolsOptions,
} from './dev_tools.js';
export { DEV_TOOLS_BINDING, flagsDevTools, registerFlagsDevTools } from './dev_tools.js';
export type { ApiRequest, ApiResponse, DeclaredFlag, Deps, Serving } from './handlers.js';
export * as handlers from './handlers.js';
export { errorResponse, HttpError, servingSummary } from './handlers.js';
export type { InjectedConfig } from './spa.js';
export {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  CONTENT_TYPES,
  contentTypeFor,
  renderIndexHtml,
} from './spa.js';
