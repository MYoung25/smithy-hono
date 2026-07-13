$version: "2.0"
namespace com.test

use com.smithyhono#cost
use com.smithyhono#requiresAuth

service PlaythroughService {
    version: "1.0"
    operations: [
        CreatePlaythrough
        DeletePlaythrough
        GetPlaythrough
        ListPlaythroughs
        UpdatePlaythrough
    ]
    errors: [ValidationException]
}

@http(method: "GET", uri: "/playthroughs/{id}", code: 200)
@readonly
@requiresAuth(permission: "playthroughs.read")
operation GetPlaythrough {
    input: GetPlaythroughInput
    output: GetPlaythroughOutput
    errors: [NotFoundError]
}

structure GetPlaythroughInput {
    @httpLabel
    @required
    id: String
}

structure GetPlaythroughOutput {
    @required
    playthrough: Playthrough
}

@http(method: "GET", uri: "/playthroughs", code: 200)
@readonly
@optionalAuth
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "limit")
operation ListPlaythroughs {
    input: ListPlaythroughsInput
    output: ListPlaythroughsOutput
}

structure ListPlaythroughsInput {
    @httpQuery("filter")
    filter: String

    @httpQuery("limit")
    @range(min: 1, max: 50)
    limit: Integer

    @httpQuery("nextToken")
    nextToken: String
}

structure ListPlaythroughsOutput {
    @required
    items: PlaythroughList

    nextToken: String
}

@http(method: "POST", uri: "/playthroughs", code: 201)
@cost(value: 5)
@requiresAuth(permission: "playthroughs.write")
operation CreatePlaythrough {
    input: CreatePlaythroughInput
    output: CreatePlaythroughOutput
}

structure CreatePlaythroughInput {
    @required
    name: String

    @required
    game: String
}

structure CreatePlaythroughOutput {
    @required
    playthrough: Playthrough
}

@http(method: "PUT", uri: "/playthroughs/{id}", code: 200)
@requiresAuth(permission: "playthroughs.write")
operation UpdatePlaythrough {
    input: UpdatePlaythroughInput
    output: UpdatePlaythroughOutput
    errors: [NotFoundError]
}

structure UpdatePlaythroughInput {
    @httpLabel
    @required
    id: String

    name: String

    currentRound: Integer
}

structure UpdatePlaythroughOutput {
    @required
    playthrough: Playthrough
}

@http(method: "DELETE", uri: "/playthroughs/{id}", code: 204)
@requiresAuth(permission: "playthroughs.write")
operation DeletePlaythrough {
    input: DeletePlaythroughInput
    errors: [NotFoundError]
}

structure DeletePlaythroughInput {
    @httpLabel
    @required
    id: String
}

structure Playthrough {
    @required
    id: String

    @required
    name: String

    currentRound: Integer
}

list PlaythroughList {
    member: Playthrough
}

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
