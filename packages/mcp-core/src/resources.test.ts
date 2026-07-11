/**
 * Resource derivation unit tests (§7): `deriveResources` groups tools by resource and
 * picks the single-id read op (attaching the list op, skipping resources with none);
 * `resourceTemplates` shapes the `{scheme}://{id}` templates; `parseResourceUri`
 * round-trips valid uris and rejects unknown schemes / malformed input. No dispatch.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  deriveResources,
  resourceTemplates,
  parseResourceUri,
  type McpTool,
} from './index.js'

const schema = z.object({}).strict()

const tools: McpTool[] = [
  {
    op: {
      name: 'GetTask',
      method: 'GET',
      path: '/tasks/:id',
      readonly: true,
      crudVerb: 'read',
      resource: 'Task',
      identifierMembers: ['id'],
      description: 'Fetch a single Task by its id.',
    },
    inputSchema: schema,
  },
  {
    op: {
      name: 'ListTasks',
      method: 'GET',
      path: '/tasks',
      readonly: true,
      crudVerb: 'list',
      resource: 'Task',
      identifierMembers: ['id'],
    },
    inputSchema: schema,
  },
  {
    op: {
      name: 'CreateTask',
      method: 'POST',
      path: '/tasks',
      crudVerb: 'create',
      resource: 'Task',
      identifierMembers: ['id'],
    },
    inputSchema: schema,
  },
  // A resource with NO read op → skipped entirely.
  {
    op: {
      name: 'ListEvents',
      method: 'GET',
      path: '/events',
      crudVerb: 'list',
      resource: 'Event',
      identifierMembers: ['id'],
    },
    inputSchema: schema,
  },
  // A read op with a COMPOSITE key → skipped (not single-id).
  {
    op: {
      name: 'GetEdge',
      method: 'GET',
      path: '/edges/:from/:to',
      crudVerb: 'read',
      resource: 'Edge',
      identifierMembers: ['from', 'to'],
    },
    inputSchema: schema,
  },
]

describe('deriveResources', () => {
  it('builds one def per resource with a single-id read op, attaching the list op', () => {
    const defs = deriveResources(tools)
    expect(defs).toHaveLength(1)
    const [task] = defs
    expect(task.resource).toBe('Task')
    expect(task.scheme).toBe('task')
    expect(task.idMember).toBe('id')
    expect(task.readOp.name).toBe('GetTask')
    expect(task.listOp?.name).toBe('ListTasks')
    expect(task.description).toBe('Fetch a single Task by its id.')
  })

  it('skips resources with no read op and read ops with a composite key', () => {
    const defs = deriveResources(tools).map((d) => d.resource)
    expect(defs).not.toContain('Event')
    expect(defs).not.toContain('Edge')
  })

  it('leaves listOp undefined when a resource has only a read op', () => {
    const [task] = deriveResources([tools[0]])
    expect(task.listOp).toBeUndefined()
  })
})

describe('resourceTemplates', () => {
  it('emits a {scheme}://{id} template per def', () => {
    const [tpl] = resourceTemplates(deriveResources(tools))
    expect(tpl).toEqual({
      uriTemplate: 'task://{id}',
      name: 'Task',
      description: 'Fetch a single Task by its id.',
      mimeType: 'application/json',
    })
  })

  it('synthesizes a description when the read op has none', () => {
    const def = deriveResources([
      { op: { ...tools[0].op, description: undefined }, inputSchema: schema },
    ])
    const [tpl] = resourceTemplates(def)
    expect(tpl.description).toBe('Read a Task by id.')
  })
})

describe('parseResourceUri', () => {
  const defs = deriveResources(tools)

  it('matches a known scheme and decodes the id', () => {
    expect(parseResourceUri('task://t%201', defs)).toEqual({ def: defs[0], id: 't 1' })
  })

  it('returns undefined for an unknown scheme', () => {
    expect(parseResourceUri('widget://x', defs)).toBeUndefined()
  })

  it('returns undefined for a malformed uri (no scheme / no id)', () => {
    expect(parseResourceUri('not-a-uri', defs)).toBeUndefined()
    expect(parseResourceUri('task://', defs)).toBeUndefined()
    expect(parseResourceUri('://x', defs)).toBeUndefined()
  })
})
