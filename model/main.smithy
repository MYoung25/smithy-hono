$version: "2"

namespace com.example

use com.smithyhono#requiresAuth
use com.smithyhono#sseEvent

service DeadeuceService {
    version: "2024-01-01"
    errors: [
        ValidationError
    ]
    operations: [
        ListPlaythroughs
        GetPlaythrough
        CreatePlaythrough
        DeletePlaythrough
    ]
}

// ── Operations ───────────────────────────────────────────────────────────────
@http(method: "GET", uri: "/playthroughs", code: 200)
@readonly
@optionalAuth
operation ListPlaythroughs {
    input: ListPlaythroughsInput
    output: ListPlaythroughsOutput
}

@requiresAuth(permission: "playthroughs.read")
@http(method: "GET", uri: "/playthroughs/{id}", code: 200)
@readonly
operation GetPlaythrough {
    input: GetPlaythroughInput
    output: GetPlaythroughOutput
    errors: [
        PlaythroughNotFound
    ]
}

@requiresAuth(permission: "playthroughs.write")
@http(method: "POST", uri: "/playthroughs", code: 201)
@idempotent
operation CreatePlaythrough {
    input: CreatePlaythroughInput
    output: CreatePlaythroughOutput
}

@requiresAuth(permission: "playthroughs.write")
@http(method: "DELETE", uri: "/playthroughs/{id}", code: 204)
@idempotent
operation DeletePlaythrough {
    input: DeletePlaythroughInput
    output: DeletePlaythroughOutput
    errors: [
        PlaythroughNotFound
    ]
}

// ── Input / Output structures ─────────────────────────────────────────────────
structure ListPlaythroughsInput {
    @httpQuery("limit")
    limit: Integer

    @httpQuery("nextToken")
    nextToken: String
}

structure ListPlaythroughsOutput {
    @required
    items: PlaythroughList

    nextToken: String
}

structure GetPlaythroughInput {
    @required
    @httpLabel
    id: String
}

structure GetPlaythroughOutput {
    @required
    item: Playthrough
}

structure CreatePlaythroughInput {
    @required
    @httpPayload
    body: CreatePlaythroughBody

    @httpHeader("X-Idempotency-Key")
    idempotencyKey: String
}

structure CreatePlaythroughBody {
    @required
    name: String

    description: String
}

structure CreatePlaythroughOutput {
    @required
    item: Playthrough
}

structure DeletePlaythroughInput {
    @required
    @httpLabel
    id: String
}

structure DeletePlaythroughOutput {}

// ── Domain shapes ─────────────────────────────────────────────────────────────
structure Playthrough {
    @required
    id: String

    @required
    name: String

    description: String

    @required
    createdAt: Timestamp

    updatedAt: Timestamp
}

list PlaythroughList {
    member: Playthrough
}

// ── Error shapes ──────────────────────────────────────────────────────────────
@error("client")
@httpError(404)
structure PlaythroughNotFound {
    @required
    message: String
}

@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String

    fieldErrors: StringMap
}

map StringMap {
    key: String
    value: String
}

// ── SSE event shapes ──────────────────────────────────────────────────────────
enum NotificationSeverity {
    INFO
    WARNING
    ERROR
}

@sseEvent(eventType: "round:changed")
structure RoundChangedEvent {
    @required
    playthroughId: String

    @required
    round: Integer
}

@sseEvent(eventType: "player:joined")
structure PlayerJoinedEvent {
    @required
    playthroughId: String

    @required
    userId: String

    @required
    characterId: String
}

@sseEvent(eventType: "ai:hint")
structure AIHintEvent {
    @required
    playthroughId: String

    @required
    chunk: String

    @required
    done: Boolean
}

@sseEvent(eventType: "notification")
structure NotificationEvent {
    @required
    playthroughId: String

    @required
    message: String

    @required
    severity: NotificationSeverity
}
