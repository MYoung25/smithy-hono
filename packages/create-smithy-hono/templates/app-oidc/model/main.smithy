$version: "2.0"

namespace com.example

use com.smithyhono#requiresAuth
use com.smithyhono#sigv4Hmac
use com.smithyhono#cost

use smithy.api#http
use smithy.api#httpLabel
use smithy.api#httpPayload
use smithy.api#readonly

/// A fully-wired SECURE reference service (ported from the smithy-hono secure-api
/// example). Every operation's auth posture is declared by the project's auth
/// traits (`com.smithyhono#requiresAuth` / `#sigv4Hmac` / `#cost`, provided by
/// model/traits.smithy) and consumed by the codegen's per-operation
/// `authSchemes` / `requiredPermissions` / `cost` registry:
///
///   - OIDC cookie sessions on CreateNote / GetNote / DeleteNote / ListNotes
///     (`@requiresAuth(permission: …)` → the `oidc` auth scheme + a scope check)
///   - an ownership resource policy (`isOwner`) wired onto GetNote / DeleteNote in
///     src/createApp.ts (the resource-policy tier is not codegen'd)
///   - CSRF on the state-changing cookie ops (engaged by the security pipeline)
///   - S2S HMAC signing (`@sigv4Hmac`) on ImportNotes — a trusted backend caller,
///     not a browser.
///
/// Add or change operations by editing this file and re-running `npm run codegen`.
service NoteService {
    version: "2024-01-01"
    operations: [CreateNote, GetNote, DeleteNote, ListNotes, ImportNotes]
}

/// Create a note owned by the calling (OIDC) user. Cookie-authed + CSRF-guarded.
@requiresAuth(permission: "notes.write")
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
@requiresAuth(permission: "notes.read")
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
@requiresAuth(permission: "notes.write")
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
@requiresAuth(permission: "notes.read")
@readonly
@http(method: "GET", uri: "/notes")
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
operation ListNotes {
    input := {
        // GET operations may not carry a request payload, so every input member
        // MUST bind to the query string (or a header/label). An unbound member
        // lands in the body → Smithy's HttpMethodSemantics.UnexpectedPayload.
        @httpQuery("nextToken")
        nextToken: String

        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer
    }
    output := {
        @required
        items: NoteList

        nextToken: String
    }
}

/// Server-to-server bulk import. Signed with `SH-HMAC-SHA256` (`@sigv4Hmac`),
/// NOT cookie-auth — used by a trusted backend service, not a browser. The
/// established service principal must hold `notes.import`.
@sigv4Hmac
@requiresAuth(permission: "notes.import")
@cost(value: 5)
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
