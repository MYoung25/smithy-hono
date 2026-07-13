/**
 * The typed Notes client the SPA drives — built ON TOP of the
 * `@smithy-hono/client-web` session.
 *
 * Everything the session gives us is wired in automatically by `browserClientOptions`:
 *   - `fetch`   — adds `credentials: 'include'` (so the __Host-session cookie rides
 *                 along), the `X-CSRF-Token` header on writes, and the
 *                 refresh-and-retry-once on a CSRF rotation (403 CsrfFailed).
 *   - `headers` — the current CSRF token, re-read per request.
 *
 * The note shapes below mirror model/main.smithy. (They are declared locally rather
 * than imported from the backend's generated code so the SPA builds independently
 * of `npm run codegen` having run in the API workspace.)
 */

import type { BrowserClientOptions } from '@smithy-hono/client-web'

/** A stored note (mirrors the `Note` shape in model/main.smithy). */
export interface Note {
  id: string
  ownerId: string
  title: string
  body?: string
  createdAt: string
}

/** The client-supplied write surface (mirrors `CreateNoteBody`). */
export interface CreateNoteBody {
  title: string
  body?: string
}

interface ListNotesOutput {
  items: Note[]
  nextToken?: string
}
interface GetNoteOutput {
  item: Note
}
interface CreateNoteOutput {
  item: Note
}

/** The note operations, each returning the modeled output shape. */
export interface NotesClient {
  listNotes(): Promise<Note[]>
  getNote(id: string): Promise<Note>
  createNote(body: CreateNoteBody): Promise<Note>
  deleteNote(id: string): Promise<void>
}

/** An error carrying the server's `{ code }` (e.g. `Unauthorized`, `CsrfFailed`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Build the typed Notes client from a `browserClientOptions(session)` result.
 */
export function createNotesClient(opts: BrowserClientOptions): NotesClient {
  const base = opts.baseUrl ?? ''

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Merge the session's per-request headers (the CSRF token) with our content-type.
    const sessionHeaders = await opts.headers()
    const res = await opts.fetch(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...sessionHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    const body = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const code = (body as { code?: string } | undefined)?.code
      const message =
        (body as { message?: string } | undefined)?.message ?? code ?? `HTTP ${res.status}`
      throw new ApiError(message, res.status, code)
    }
    return body as T
  }

  return {
    async listNotes() {
      const out = await call<ListNotesOutput>('/notes')
      return out.items
    },
    async getNote(id) {
      const out = await call<GetNoteOutput>(`/notes/${encodeURIComponent(id)}`)
      return out.item
    },
    async createNote(body) {
      const out = await call<CreateNoteOutput>('/notes', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return out.item
    },
    async deleteNote(id) {
      await call<void>(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
