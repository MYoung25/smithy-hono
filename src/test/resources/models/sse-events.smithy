$version: "2.0"
namespace com.test

use com.smithyhono#sseEvent
use com.smithyhono#sseStream

service GameService {
    version: "1.0"
    operations: [Ping]
}

@http(method: "GET", uri: "/ping", code: 200)
@optionalAuth
@sseStream
operation Ping {
    output: PingOutput
}

structure PingOutput {
    @required
    status: String
}

@sseEvent(eventType: "game:started")
structure GameStartedEvent {
    @required
    gameId: String

    @required
    playerCount: Integer
}

@sseEvent(eventType: "game:ended")
structure GameEndedEvent {
    @required
    gameId: String

    winner: String
}

@sseEvent(eventType: "player:moved")
structure PlayerMovedEvent {
    @required
    gameId: String

    @required
    playerId: String

    @required
    position: String
}
