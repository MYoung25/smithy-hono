/**
 * The example's domain store for notes.
 *
 * Deliberately tiny + in-memory: this example is a SECURITY-wiring reference, not
 * a persistence reference (the *security* state — sessions / nonces / signing keys
 * — is what lives on the real Redis adapter; see src/server.ts). A `Note` carries
 * an `ownerId` so the `isOwner` resource policy (AUTHZ) has a field to check.
 */

import type { Note } from '../generated/notes.gen'

export interface NotesStore {
  create(note: Note): Promise<Note>
  get(id: string): Promise<Note | null>
  delete(id: string): Promise<boolean>
  listByOwner(ownerId: string): Promise<Note[]>
}

/** In-memory {@link NotesStore} — process-local, fine for the example + tests. */
export function createMemoryNotesStore(): NotesStore {
  const byId = new Map<string, Note>()
  return {
    async create(note) {
      byId.set(note.id, note)
      return note
    },
    async get(id) {
      return byId.get(id) ?? null
    },
    async delete(id) {
      return byId.delete(id)
    },
    async listByOwner(ownerId) {
      return [...byId.values()].filter((n) => n.ownerId === ownerId)
    },
  }
}
