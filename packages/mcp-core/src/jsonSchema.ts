/**
 * Zod → JSON Schema for MCP tool `inputSchema`/`outputSchema`.
 *
 * Reusing the generated Zod schemas (not emitting JSON Schema separately) keeps
 * the MCP tool contract provably identical to what the Hono router validates —
 * one source of truth, no drift. `$refStrategy: 'none'` inlines `$defs` so each
 * tool schema is self-contained (maximally client-compatible).
 */

import type { ZodType } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

export type JsonSchema = Record<string, unknown>

export function toJsonSchema(schema: ZodType): JsonSchema {
  const js = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonSchema
  // MCP tool schemas don't carry a `$schema` dialect marker.
  delete js.$schema
  return js
}
