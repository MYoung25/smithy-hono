/**
 * The typed Notes client the SPA drives — built ON TOP of the
 * `@smithy-hono/client-web` session.
 *
 * secure-api's codegen emits the server-side router + the request/response TYPES
 * (`generated/notes.gen.ts`), but no standalone browser client factory. So this
 * file plays the role the README's `createNotesClient(browserClientOptions(session))`
 * would: it takes the `{ fetch, headers }` that {@link browserClientOptions}
 * produces and exposes the five note operations with the GENERATED types — which we
 * import by RELATIVE PATH (type-only, so no Hono/zod runtime is pulled into the
 * bundle, and the generated code is NOT copied).
 *
 * Everything the session gives us is wired in automatically by `browserClientOptions`:
 *   - `fetch`   — adds `credentials: 'include'` (so the __Host-session cookie rides
 *                 along), the `X-CSRF-Token` header on writes, and the
 *                 refresh-and-retry-once on a CSRF rotation (403 CsrfFailed).
 *   - `headers` — the current CSRF token, re-read per request.
 */

import type { BrowserClientOptions } from '@smithy-hono/client-web'
// Type-only import of the generated shapes — NOT a copy, and (being `import type`)
// it contributes zero runtime + does not drag the generated router's hono/zod
// imports into the SPA bundle.
import type {
  Note,
  CreateNoteBody,
  CreateNoteOutput,
  ListNotesOutput,
  GetNoteOutput,
} from '../../secure-api/generated/notes.gen'

export type { Note, CreateNoteBody }

/** The five note operations, each returning the generated output shape. */
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
 * Pass `browserClientOptions(session)` straight in — same call site the
 * client-web README shows for a generated `createXyzClient(...)`.
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
