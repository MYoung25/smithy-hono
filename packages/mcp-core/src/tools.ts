/**
 * Build the MCP tool descriptor (what `tools/list` returns) from an {@link McpTool}.
 * Annotations are derived from the operation metadata; the description prefers an
 * explicit one, then the operation's `@documentation`, then a synthesized fallback.
 */

import type { McpOperationMeta, McpTool } from './types.js'
import { toJsonSchema, type JsonSchema } from './jsonSchema.js'

export interface McpToolDescriptor {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: {
    readOnlyHint: boolean
    idempotentHint: boolean
    destructiveHint: boolean
    openWorldHint: boolean
  }
}

const VERB_PHRASE: Record<NonNullable<McpOperationMeta['crudVerb']>, string> = {
  create: 'Create a',
  put: 'Create or replace a',
  read: 'Get a',
  update: 'Update a',
  delete: 'Delete a',
  list: 'List',
}

/** A last-resort description so a tool is never unusable to an LLM. */
function synthesizeDescription(op: McpOperationMeta): string {
  if (op.crudVerb && op.resource) {
    const phrase = VERB_PHRASE[op.crudVerb]
    return op.crudVerb === 'list' ? `${phrase} ${op.resource} records.` : `${phrase} ${op.resource}.`
  }
  return `${op.method} ${op.path}`
}

function isIdempotent(op: McpOperationMeta): boolean {
  if (op.method === 'GET') return true
  return op.crudVerb === 'put' || op.crudVerb === 'update' || op.crudVerb === 'delete'
}

export function buildToolDescriptor(tool: McpTool): McpToolDescriptor {
  const { op } = tool
  return {
    name: op.name,
    title: tool.title,
    description: tool.description ?? op.description ?? synthesizeDescription(op),
    inputSchema: toJsonSchema(tool.inputSchema),
    outputSchema: tool.outputSchema ? toJsonSchema(tool.outputSchema) : undefined,
    annotations: {
      readOnlyHint: op.readonly === true,
      idempotentHint: isIdempotent(op),
      destructiveHint: op.crudVerb === 'delete',
      // Closed world: tools operate on this service's own data store.
      openWorldHint: false,
    },
  }
}
