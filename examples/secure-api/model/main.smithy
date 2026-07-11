$version: "2.0"

namespace com.example.secure

use smithy.api#http
use smithy.api#httpLabel
use smithy.api#httpPayload
use smithy.api#readonly

/// A fully-wired SECURE reference service (OPS-08).
///
/// Demonstrates every security layer the runtime offers against a REAL adapter
/// (adapter-node + Redis):
///   - OIDC cookie sessions on a Redis SessionStore (CreateNote / GetNote / DeleteNote)
///   - a resource policy (`isOwner`) on GetNote / DeleteNote
///   - CSRF on the state-changing cookie ops (CreateNote / DeleteNote)
///   - S2S HMAC signing (`@sigv4Hmac`) on ImportNotes
///
/// NOTE: the checked-in `generated/*.gen.ts` is produced by the smithy-hono
/// `hono-codegen` plugin from this model (same plugin todo-api uses); it is
/// committed so the example builds standalone without re-running gradle. The
/// `@requiresAuth` / `@sigv4Hmac` / `@requiresResourcePolicy` traits below are the
/// project's auth traits (mirrored from todo-api's model) that drive the codegen's
/// per-operation `authSchemes` / `requiredPermissions` / resource-policy slot.
@httpBasicAuth
service SecureService {
    version: "2024-01-01"
    operations: [CreateNote, GetNote, DeleteNote, ListNotes, ImportNotes]
}

/// Create a note owned by the calling (OIDC) user. Cookie-authed + CSRF-guarded.
@http(method: "POST", uri: "/notes")
operation CreateNote {
    input := {
        @httpPayload
        body: CreateNoteBody
    }
    output := {
        item: Note
    }
    errors: [ValidationError, ThrottlingException]
}

/// Read one note. Cookie-authed; guarded by an ownership resource policy (isOwner).
@readonly
@http(method: "GET", uri: "/notes/{id}")
operation GetNote {
    input := {
        @httpLabel
        @required
        id: String
    }
    output := {
        item: Note
    }
    errors: [NoteNotFound, ThrottlingException]
}

/// Delete one note. Cookie-authed + CSRF-guarded; guarded by isOwner.
@http(method: "DELETE", uri: "/notes/{id}")
operation DeleteNote {
    input := {
        @httpLabel
        @required
        id: String
    }
    errors: [NoteNotFound, ThrottlingException]
}

/// List the caller's notes. Cookie-authed (read scope), no per-resource policy.
@readonly
@http(method: "GET", uri: "/notes")
operation ListNotes {
    input := {
        nextToken: String
    }
    output := {
        items: NoteList
        nextToken: String
    }
}

/// Server-to-server bulk import. Signed with `SH-HMAC-SHA256` (`@sigv4Hmac`),
/// NOT cookie-auth — used by a trusted backend service, not a browser.
@http(method: "POST", uri: "/s2s/import")
operation ImportNotes {
    input := {
        @httpPayload
        body: ImportNotesBody
    }
    output := {
        imported: Integer
    }
    errors: [ValidationError, ThrottlingException]
}

structure CreateNoteBody {
    @required
    title: String

    body: String
}

structure ImportNotesBody {
    @required
    notes: ImportNoteList
}

list ImportNoteList {
    member: ImportNote
}

structure ImportNote {
    @required
    ownerId: String

    @required
    title: String
}

structure Note {
    @required
    id: String

    @required
    ownerId: String

    @required
    title: String

    body: String

    @required
    createdAt: String
}

list NoteList {
    member: Note
}

@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
}

@error("client")
@httpError(404)
structure NoteNotFound {
    @required
    message: String
}

@error("client")
@httpError(429)
@retryable(throttling: true)
structure ThrottlingException {
    @required
    message: String
}
