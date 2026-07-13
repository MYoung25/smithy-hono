/**
 * Domain implementation of the generated `NoteOperations` interface.
 *
 * Security is NOT implemented here — it is engaged entirely by the pipeline +
 * generated `authorize` hooks + the resource-policy middleware wired in
 * src/server.ts. These handlers assume they only ever run for a request that has
 * already passed authentication, authorization, CSRF, and (for ImportNotes) S2S
 * signature verification. They read the caller's identity via the request-scoped
 * {@link currentPrincipal} (populated by the `all`-slot middleware in server.ts).
 */

import type {
  NoteOperations,
  Note,
  CreateNoteOutput,
  GetNoteOutput,
  ListNotesOutput,
  ImportNotesOutput,
} from '../generated/notes.gen'
import { NoteNotFound } from '../generated/notes.gen'
import type { NotesStore } from './notesStore'
import { requirePrincipal } from './requestContext'

export function createNoteOps(store: NotesStore): NoteOperations {
  return {
    async CreateNote({ body }) {
      // Owner is the authenticated OIDC user (principal.id from the session).
      const owner = requirePrincipal()
      const note: Note = {
        id: crypto.randomUUID(),
        ownerId: owner.id,
        title: body.title,
        body: body.body,
        createdAt: new Date().toISOString(),
      }
      await store.create(note)
      return { item: note } satisfies CreateNoteOutput
    },

    async GetNote({ id }) {
      // The isOwner resource policy (server.ts) already enforced ownership AND
      // stashed the loaded note on context; we re-read from the store for a
      // self-contained handler. A 404 here is unreachable in practice (the
      // policy 404s a missing note first) but kept for defense in depth.
      const note = await store.get(id)
      if (!note) throw new NoteNotFound(`Note ${id} not found`)
      return { item: note } satisfies GetNoteOutput
    },

    async DeleteNote({ id }) {
      const ok = await store.delete(id)
      if (!ok) throw new NoteNotFound(`Note ${id} not found`)
    },

    async ListNotes() {
      const owner = requirePrincipal()
      const items = await store.listByOwner(owner.id)
      return { items } satisfies ListNotesOutput
    },

    async ImportNotes({ body }) {
      // S2S path: the service principal (from the verified signature) is in scope.
      // Each imported note carries its own ownerId from the trusted caller.
      let imported = 0
      for (const n of body.notes) {
        await store.create({
          id: crypto.randomUUID(),
          ownerId: n.ownerId,
          title: n.title,
          createdAt: new Date().toISOString(),
        })
        imported++
      }
      return { imported } satisfies ImportNotesOutput
    },
  }
}
