$version: "2.0"
namespace com.test

use com.smithyhono#persisted

/// A multi-resource service exercising the cross-entity codegen defects:
///  - UserData and PlaythroughData are each referenced by BOTH resource groups
///    (so they are hoisted to shared.gen.ts),
///  - NotFoundError + ValidationException are service-level (bound to every op,
///    so they are hoisted to errors.gen.ts instead of redeclared per resource),
///  - Playthrough declares a @persisted index whose key matches a list @httpQuery.
service MultiEntityService {
    version: "1.0"
    resources: [User, Playthrough]
    errors: [ValidationException]
}

// ── User ────────────────────────────────────────────────────────────────────

@persisted
resource User {
    identifiers: { id: String }
    create: CreateUser
    read: GetUser
    update: UpdateUser
    delete: DeleteUser
    list: ListUsers
}

@http(method: "POST", uri: "/users", code: 201)
@optionalAuth
operation CreateUser {
    input: CreateUserInput
    output: CreateUserOutput
    errors: [NotFoundError]
}

@http(method: "GET", uri: "/users/{id}", code: 200)
@optionalAuth
@readonly
operation GetUser {
    input: GetUserInput
    output: GetUserOutput
    errors: [NotFoundError]
}

@http(method: "PUT", uri: "/users/{id}", code: 200)
@optionalAuth
@idempotent
operation UpdateUser {
    input: UpdateUserInput
    output: UpdateUserOutput
    errors: [NotFoundError]
}

@http(method: "DELETE", uri: "/users/{id}", code: 204)
@optionalAuth
@idempotent
operation DeleteUser {
    input: DeleteUserInput
    errors: [NotFoundError]
}

@http(method: "GET", uri: "/users", code: 200)
@optionalAuth
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
operation ListUsers {
    input: ListUsersInput
    output: ListUsersOutput
}

structure CreateUserInput {
    @required
    name: String
}

structure CreateUserOutput {
    item: UserData
}

structure GetUserInput {
    @httpLabel
    @required
    id: String
}

structure GetUserOutput {
    item: UserData
}

structure UpdateUserInput {
    @httpLabel
    @required
    id: String

    name: String
}

structure UpdateUserOutput {
    item: UserData
}

structure DeleteUserInput {
    @httpLabel
    @required
    id: String
}

structure ListUsersInput {
    @httpQuery("nextToken")
    nextToken: String

    @httpQuery("maxResults")
    maxResults: Integer
}

structure ListUsersOutput {
    items: UserList
    nextToken: String
}

list UserList {
    member: UserData
}

structure UserData {
    @required
    id: String

    name: String

    // Cross-reference: a User carries its most-recent Playthrough's entity type, so
    // PlaythroughData is reachable from BOTH groups and gets hoisted.
    lastPlaythrough: PlaythroughData

    createdAt: Timestamp
    updatedAt: Timestamp
}

// ── Playthrough ──────────────────────────────────────────────────────────────

@persisted(indexes: [{ name: "byGame", key: "gameId" }])
resource Playthrough {
    identifiers: { id: String }
    create: CreatePlaythrough
    read: GetPlaythrough
    update: UpdatePlaythrough
    delete: DeletePlaythrough
    list: ListPlaythroughs
}

@http(method: "POST", uri: "/playthroughs", code: 201)
@optionalAuth
operation CreatePlaythrough {
    input: CreatePlaythroughInput
    output: CreatePlaythroughOutput
    errors: [NotFoundError]
}

@http(method: "GET", uri: "/playthroughs/{id}", code: 200)
@optionalAuth
@readonly
operation GetPlaythrough {
    input: GetPlaythroughInput
    output: GetPlaythroughOutput
    errors: [NotFoundError]
}

@http(method: "PUT", uri: "/playthroughs/{id}", code: 200)
@optionalAuth
@idempotent
operation UpdatePlaythrough {
    input: UpdatePlaythroughInput
    output: UpdatePlaythroughOutput
    errors: [NotFoundError]
}

@http(method: "DELETE", uri: "/playthroughs/{id}", code: 204)
@optionalAuth
@idempotent
operation DeletePlaythrough {
    input: DeletePlaythroughInput
    errors: [NotFoundError]
}

@http(method: "GET", uri: "/playthroughs", code: 200)
@optionalAuth
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
operation ListPlaythroughs {
    input: ListPlaythroughsInput
    output: ListPlaythroughsOutput
}

structure CreatePlaythroughInput {
    @required
    gameId: String
}

structure CreatePlaythroughOutput {
    item: PlaythroughData
}

structure GetPlaythroughInput {
    @httpLabel
    @required
    id: String
}

structure GetPlaythroughOutput {
    item: PlaythroughData
}

structure UpdatePlaythroughInput {
    @httpLabel
    @required
    id: String

    gameId: String
}

structure UpdatePlaythroughOutput {
    item: PlaythroughData
}

structure DeletePlaythroughInput {
    @httpLabel
    @required
    id: String
}

structure ListPlaythroughsInput {
    @httpQuery("gameId")
    gameId: String

    @httpQuery("nextToken")
    nextToken: String

    @httpQuery("maxResults")
    maxResults: Integer
}

structure ListPlaythroughsOutput {
    items: PlaythroughList
    nextToken: String
}

list PlaythroughList {
    member: PlaythroughData
}

structure PlaythroughData {
    @required
    id: String

    gameId: String

    // Cross-reference back to UserData, so UserData is reachable from BOTH groups.
    owner: UserData

    createdAt: Timestamp
    updatedAt: Timestamp
}

// ── Shared service-level errors ──────────────────────────────────────────────

@error("client")
@httpError(404)
structure NotFoundError {
    message: String
}

@error("client")
@httpError(400)
structure ValidationException {
    message: String
}
