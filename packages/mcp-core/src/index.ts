/**
 * `@smithy-hono/mcp-core` — expose a generated smithy-hono service as an MCP
 * server. Feed it the operation metadata (`OPERATIONS` from registry.gen.ts) +
 * the emitted Zod schemas as {@link McpTool}s and the Hono app, and mount the
 * returned handler:
 *
 *   const handler = createMcpHandler({ tools, app, info: { name, version } })
 *   app.all('/mcp', (c) => handler(c.req.raw))
 */

export { createMcpHandler } from './handler.js'
export { buildToolDescriptor, type McpToolDescriptor } from './tools.js'
export {
  buildRequest,
  callOperation,
  attachPrincipal,
  getAttachedPrincipal,
  McpDispatchError,
  type DispatchResult,
} from './dispatch.js'
export {
  protectedResourceMetadata,
  resolveBearer,
  challenge401,
  challenge403,
  requiredScopes,
  isAnonymous,
  principalFromClaims,
} from './auth.js'
export { toJsonSchema, type JsonSchema } from './jsonSchema.js'
export {
  deriveResources,
  resourceTemplates,
  parseResourceUri,
  type ResourceDef,
} from './resources.js'
export {
  listPrompts,
  renderPrompt,
  findPrompt,
  McpPromptError,
  type McpPromptDescriptor,
} from './prompts.js'
export {
  createContext,
  handleMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpContext,
  type McpHttpChallenge,
} from './protocol.js'
export type {
  McpHandlerConfig,
  McpTool,
  McpOperationMeta,
  McpServerInfo,
  FetchLike,
  HttpMethod,
  CrudVerb,
  McpAuthConfig,
  BearerVerifier,
  VerifiedTokenClaims,
  McpPrincipal,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  McpPromptArgument,
} from './types.js'
