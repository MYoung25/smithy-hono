$version: "2.0"
namespace com.test

// CG-09 fixture: reserved-word member names (`class`, `default`) must be emitted as
// quoted keys, and a struct whose NAME collides with a JS global (`Number`) must be
// suffixed so it never shadows the global — yielding valid, non-shadowing TS.
service ReservedService {
    version: "1.0"
    operations: [
        PutReserved
    ]
}

@http(method: "POST", uri: "/reserved", code: 200)
@optionalAuth
operation PutReserved {
    input: PutReservedInput
    output: PutReservedOutput
}

structure PutReservedInput {
    @httpPayload
    @required
    body: ReservedBody
}

structure ReservedBody {
    @required
    class: String

    default: String

    num: Number
}

structure PutReservedOutput {
    @required
    ok: Boolean
}

// Struct NAME collides with the JS global `Number` → suffixed to `NumberShape`.
structure Number {
    @required
    amount: Integer
}
