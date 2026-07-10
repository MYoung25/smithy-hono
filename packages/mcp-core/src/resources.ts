/**
 * MCP resources (§7) — derived entirely at runtime from the tools' registry
 * metadata, the same way the auth slice reads `requiredPermissions` (no codegen /
 * manifest change). Each `@persisted` resource with a single-id read op becomes a
 * `{scheme}://{id}` URI template whose `resources/read` dispatches that read op and
 * whose `resources/list` enumerates via the resource's list op. Web-standard only
 * (ARCH-01): the dispatch goes through the same {@link callOperation} primitive.
 */

import type {
  FetchLike,
  McpOperationMeta,
  McpPrincipal,
  McpResource,
  McpResourceTemplate,
  McpTool,
} from './types.js'
import { callOperation } from './dispatch.js'

const MIME_JSON = 'application/json'

/**
 * One derivable resource: a resource name plus its read op (always) and list op
 * (when present). `scheme`/`idMember` are pre-computed so the URI helpers stay trivial.
 */
export interface ResourceDef {
  /** Resource name, e.g. `Task`. */
  resource: string
  /** URI scheme — `resource.toLowerCase()`, e.g. `task`. */
  scheme: string
  /** The single identifier member, e.g. `id`. */
  idMember: string
  /** The `read` op (crudVerb 'read') — drives `resources/read`. */
  readOp: McpOperationMeta
  /** The `list` op (crudVerb 'list'), when the resource has one — drives `resources/list`. */
  listOp?: McpOperationMeta
  /** Description carried onto the template (prefers the read op's). */
  description?: string
}

/**
 * Group tools by `op.resource` and, for each resource that has a single-id `read`
 * op, build a {@link ResourceDef} (attaching its `list` op when present). Resources
 * with no single-id read op are skipped — keeping resources "nearly free" (§7): a
 * service that doesn't model a by-id read simply exposes no resources.
 */
export function deriveResources(tools: McpTool[]): ResourceDef[] {
  const byResource = new Map<string, McpOperationMeta[]>()
  for (const { op } of tools) {
    if (!op.resource) continue
    const ops = byResource.get(op.resource)
    if (ops) ops.push(op)
    else byResource.set(op.resource, [op])
  }

  const defs: ResourceDef[] = []
  for (const [resource, ops] of byResource) {
    const readOp = ops.find(
      (op) => op.crudVerb === 'read' && op.identifierMembers?.length === 1,
    )
    if (!readOp) continue
    const listOp = ops.find((op) => op.crudVerb === 'list')
    defs.push({
      resource,
      scheme: resource.toLowerCase(),
      idMember: readOp.identifierMembers![0],
      readOp,
      listOp,
      description: readOp.description,
    })
  }
  return defs
}

/** The `resources/templates/list` payload: one `{scheme}://{id}` template per def. */
export function resourceTemplates(defs: ResourceDef[]): McpResourceTemplate[] {
  return defs.map((def) => ({
    uriTemplate: `${def.scheme}://{${def.idMember}}`,
    name: def.resource,
    description: def.description ?? `Read a ${def.resource} by ${def.idMember}.`,
    mimeType: MIME_JSON,
  }))
}

/**
 * Parse a `{scheme}://{id}` URI against the known defs. Returns the matched def and
 * the decoded id, or `undefined` for an unknown scheme / malformed (no `://`) URI.
 */
export function parseResourceUri(
  uri: string,
  defs: ResourceDef[],
): { def: ResourceDef; id: string } | undefined {
  const sep = uri.indexOf('://')
  if (sep <= 0) return undefined
  const scheme = uri.slice(0, sep)
  const rawId = uri.slice(sep + 3)
  if (!rawId) return undefined
  const def = defs.find((d) => d.scheme === scheme)
  if (!def) return undefined
  try {
    return { def, id: decodeURIComponent(rawId) }
  } catch {
    // A malformed percent-encoding can't be a valid id.
    return undefined
  }
}

/** Resolve the principal a given (possibly protected) op dispatches with, per call. */
export type PrincipalFor = (op: McpOperationMeta) => McpPrincipal | undefined

/**
 * `resources/list` — enumerate concrete instances across all defs by dispatching
 * each def's list op once and mapping items → {@link McpResource}. A def with no
 * list op contributes only its template (no concrete resources here). The first list
 * op to surface a `nextToken` becomes the aggregate `nextCursor` — enough for the
 * common single-resource service; multi-resource paging stays a future concern (§7).
 */
export async function listResources(
  app: FetchLike,
  defs: ResourceDef[],
  origin: string | undefined,
  principalFor: PrincipalFor,
): Promise<{ resources: McpResource[]; nextCursor?: string }> {
  const resources: McpResource[] = []
  let nextCursor: string | undefined

  for (const def of defs) {
    if (!def.listOp) continue
    const { ok, body } = await callOperation(
      app,
      def.listOp,
      {},
      origin,
      principalFor(def.listOp),
    )
    if (!ok || !body || typeof body !== 'object') continue

    const items = (body as { items?: unknown[] }).items
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const idValue = (item as Record<string, unknown>)[def.idMember]
        if (idValue === undefined || idValue === null) continue
        const id = String(idValue)
        resources.push({
          uri: `${def.scheme}://${encodeURIComponent(id)}`,
          name: `${def.resource} ${id}`,
          mimeType: MIME_JSON,
        })
      }
    }

    const token = (body as { nextToken?: unknown }).nextToken
    if (nextCursor === undefined && typeof token === 'string') nextCursor = token
  }

  return nextCursor === undefined ? { resources } : { resources, nextCursor }
}

/** A successful `resources/read` body: the read op's JSON under the requested uri. */
export interface ResourceContents {
  contents: { uri: string; mimeType: string; text: string }[]
}

/**
 * `resources/read` — dispatch the def's read op with `{ [idMember]: id }`. A
 * successful dispatch returns the body as a single JSON `contents` entry; a `!ok`
 * dispatch (e.g. a modeled 404) is reported as `{ notFound: true }` so the protocol
 * layer can emit the JSON-RPC `-32002` "Resource not found" error.
 */
export async function readResource(
  app: FetchLike,
  def: ResourceDef,
  id: string,
  origin: string | undefined,
  principal: McpPrincipal | undefined,
): Promise<ResourceContents | { notFound: true }> {
  const uri = `${def.scheme}://${encodeURIComponent(id)}`
  const { ok, body } = await callOperation(
    app,
    def.readOp,
    { [def.idMember]: id },
    origin,
    principal,
  )
  if (!ok) return { notFound: true }
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return { contents: [{ uri, mimeType: MIME_JSON, text }] }
}
