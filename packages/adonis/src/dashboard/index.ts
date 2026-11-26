// The federated console: other apps' own flags, shown and edited here (`apps`).
export type {
  ConsoleCommandsOption,
  FederatedAppInfo,
  FederatedControlPlane,
  FederatedFlagsApp,
  FlagsConsoleProfile,
} from '../federation/console.js';
export {
  consoleCommandKeys,
  FLAGS_CONSOLE_CAPABILITIES,
  flagsConsoleCapabilityAllows,
} from '../federation/console.js';
export {
  CONSOLE_AUTH_DOCS,
  ConsoleAuthConfigError,
} from '../federation/console_auth.js';
export type { ConsoleCipher, ConsoleCipherSource } from '../federation/redis_channel.js';
export {
  CONSOLE_CRYPTO_KEY,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../federation/redis_channel.js';
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
export {
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from './console_capabilities.js';
export type {
  ConsoleSignOut,
  ConsoleViewer,
  SignOutOption,
  ViewerHook,
} from './console_shell.js';
// The console shell's sidebar footer: who is signed in, and how to sign out.
export { resolveSignOut, resolveViewer, viewerFromUser } from './console_shell.js';
export type {
  AgoraConsoleEntry,
  AgoraConsoleIcon,
  AgoraConsoleRegistry,
  AgoraConsoleSearchHit,
  ConsoleSearchResults,
  FlagsSearchSource,
  VisibleConsole,
  VisibleConsoles,
} from './console_switcher.js';
// The cross-console switcher registry (`'agora.consoles'`) and global search.
export {
  AGORA_CONSOLES_BINDING,
  flagsConsoleSearch,
  listVisibleConsoles,
  readAgoraConsoles,
  registerAgoraConsole,
  searchConsoles,
} from './console_switcher.js';
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
export type {
  ApiRequest,
  ApiResponse,
  ConsoleApp,
  DeclaredFlag,
  Deps,
  Serving,
} from './handlers.js';
export * as handlers from './handlers.js';
export { errorResponse, HttpError, servingSummary } from './handlers.js';
export type { InjectedConfig, ShellFields, SwitcherConfig } from './spa.js';
export {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  CONTENT_TYPES,
  contentTypeFor,
  renderIndexHtml,
} from './spa.js';
