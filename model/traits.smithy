$version: "2.0"

namespace com.smithyhono

/// Applied to operations that require authentication.
/// The permission string is checked against the session's permission set.
@trait(selector: "operation")
structure requiresAuth {
    /// Optional permission key (e.g. "playthroughs.write").
    /// If omitted, any authenticated user is allowed.
    permission: String
}

/// Marks a structure as an SSE event type.
/// The eventType string becomes the `event:` field in the SSE wire format.
@trait(selector: "structure")
structure sseEvent {
    @required
    eventType: String
}

/// Relative cost of an operation for the runtime rate limiter (RATE-07).
/// Defaults to 1 when absent.
@trait(selector: "operation")
structure cost {
    @required
    value: Integer
}

/// Marks an operation as requiring the custom SH-HMAC-SHA256 service-to-service
/// request signing scheme (SIGN-*). Surfaces as a 'sigv4Hmac' auth scheme.
@trait(selector: "operation")
structure sigv4Hmac {}

/// Marks an HTTP operation as a streaming (Server-Sent-Events) endpoint, surfaced
/// as `streaming: true` in the metadata registry so the security-headers middleware
/// skips `Cache-Control: no-store` on the response (HDR-07 route-class).
@trait(selector: "operation")
structure sseStream {}

/// Marks a `resource` shape as having a default DB-backed CRUD implementation
/// generated for it (Plan 13). Bare `@persisted` = all config defaulted; the rich
/// form carries storage config a resource shape can't express. `@persisted` only
/// changes WHO writes the operation handlers; the lifecycle operations are declared
/// normally with their @http/@paginated/errors.
@trait(selector: "resource")
structure persisted {
    /// Collection / key-prefix; default = lowercased resource name.
    table: String

    /// Auto-manage createdAt/updatedAt iff the entity declares them. Default true.
    timestamps: Boolean

    /// Tombstone instead of hard delete (adds deletedAt). Default false.
    softDelete: Boolean

    /// Version-guarded writes + 409. MVP default OFF (D5 seam present).
    optimisticConcurrency: Boolean

    /// Owner scoping field, auto-injected from principal.id; scopes list/read.
    ownerField: String

    /// Tenant scoping field, auto-injected from principal.tenantId (AUTHZ-07).
    tenantField: String

    /// Explicit, auditable opt-out: marks the resource as intentionally single-tenant
    /// or public so the unscoped-IDOR advisory and `enforceResourceScoping` enforcement
    /// are suppressed for it. Default false.
    allowUnscoped: Boolean

    /// Declared secondary indexes for filtered list queries.
    indexes: PersistedIndexList
}

/// Marks a @persisted resource as realtime-observable (Phase L1). Generates a functional SSE
/// subscribe endpoint keyed by the resource id and wires notify-on-commit so a successful write
/// pushes a `{ id, version }` notification to that key's subscribers. The store's monotonic
/// `version` is the reconcile cursor; clients refetch on a newer version. Backend (polling vs
/// Durable Object push) is a deploy-time choice; the generated code targets the
/// @smithy-hono/realtime RealtimeHub port, not a specific backend.
@trait(selector: "resource [trait|com.smithyhono#persisted]")
structure live {
    /// Channel-key member; default = the resource identifier member (the DataStore key).
    keyMember: String

    /// Event `type` emitted on commit; default = "<lowercasedResource>:updated".
    eventType: String

    /// Also emit created/deleted lifecycle events in addition to updated. Default false.
    lifecycleEvents: Boolean

    /// Emit {records, version} frames instead of {id, version} hints. Only valid when the
    /// resource has no per-recipient redaction. Default false.
    pushRecords: Boolean
}

@private
list PersistedIndexList {
    member: PersistedIndex
}

@private
structure PersistedIndex {
    @required
    name: String

    @required
    key: String
}

/// One or more MCP prompts (Plan 14, §12) surfaced by @smithy-hono/mcp-core.
/// Attaches to a `service` (service-wide prompts) or an `operation` (operation-anchored
/// prompts — the emitter can default the name + reference the op's generated tool and
/// input members). Each prompt becomes a `prompts/list` entry whose `prompts/get`
/// interpolates `{argName}` placeholders in `template` into a single user-role text
/// message. Prompts do NOT dispatch operations, so prompts/get is never auth-gated.
@trait(selector: ":is(service, operation)")
list mcpPrompts {
    member: McpPrompt
}

@private
structure McpPrompt {
    /// Prompt name (unique within the service). Optional on an OPERATION (defaults to
    /// the kebab-cased operation name); REQUIRED on a service-level prompt.
    name: String

    /// Human-readable description shown to the user/agent choosing the prompt.
    description: String

    /// Declared arguments. A `{name}` placeholder in `template` that names one of these
    /// is substituted at prompts/get time. On an operation, omit to AUTO-DERIVE from the
    /// op's input members (§12.2); provide to override.
    arguments: McpPromptArgumentList

    /// The message template. `{argName}` placeholders are replaced by the supplied
    /// argument values; everything else is literal. Required.
    @required
    template: String
}

@private
list McpPromptArgumentList {
    member: McpPromptArgument
}

@private
structure McpPromptArgument {
    @required
    name: String

    /// Shown next to the argument in prompts/list.
    description: String

    /// Whether prompts/get must be given this argument. Default false.
    required: Boolean
}
