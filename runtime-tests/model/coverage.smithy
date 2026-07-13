$version: "2.0"
namespace com.coverage

// Coverage model for the runtime/behavioral validator harness (CG-11).
//
// Unlike the snapshot fixtures (which assert emitted TEXT) and TypeCheckTest
// (which asserts the text COMPILES), this model exists to be *driven*: the
// generated router is mounted in an in-memory Hono app and real requests are
// pushed through the generated zValidators. Each operation isolates a class of
// validator behavior so a behavioral regression (e.g. CG-01 string-query
// coercion, CG-02 enum wire values) fails loudly instead of silently.
//
// All operations are @optionalAuth so the harness needs no session/auth wiring.

service CoverageService {
    version: "1.0"
    operations: [
        EchoParams
        CreateThing
        EchoMaps
        Reserved
        MakeWidget
        PutShapes
    ]
}

// CG-01 — path/query/header params arrive as STRINGS and must coerce.
@http(method: "GET", uri: "/echo/{count}", code: 200)
@readonly
@optionalAuth
operation EchoParams {
    input: EchoParamsInput
    output: EchoParamsOutput
}

structure EchoParamsInput {
    // @httpLabel number — wire form "/echo/42" → 42
    @httpLabel
    @required
    count: Integer

    // @httpQuery number — "?limit=5" → 5
    @httpQuery("limit")
    limit: Integer

    // @httpQuery float — "?ratio=1.5" → 1.5
    @httpQuery("ratio")
    ratio: Float

    // @httpQuery boolean — "?flag=true" → true (and "false" → false, NOT true)
    @httpQuery("flag")
    flag: Boolean

    // @httpQuery enum — CG-02 explicit wire value "?status=active"
    @httpQuery("status")
    status: Status

    // @httpQuery with @range on the TARGET shape — CG-04. "?size=10" → 10 (in range);
    // "?size=999" → 400 (the .max(50) must survive onto the coerced validator).
    @httpQuery("size")
    size: PageSize

    // @httpHeader number — "X-Count: 7" → 7
    @httpHeader("X-Count")
    headerCount: Integer
}

structure EchoParamsOutput {
    @required
    count: Integer

    limit: Integer
    ratio: Float
    flag: Boolean
    status: Status
    size: PageSize
    headerCount: Integer
}

// CG-01 (body stays strict) + CG-02 (enum / intEnum wire values in a JSON body).
@http(method: "POST", uri: "/things", code: 201)
@optionalAuth
operation CreateThing {
    input: CreateThingInput
    output: CreateThingOutput
}

structure CreateThingInput {
    @httpPayload
    @required
    body: ThingBody
}

structure ThingBody {
    // JSON body number — must NOT coerce: "5" (string) is rejected.
    @required
    count: Integer

    // JSON body boolean — must NOT coerce.
    @required
    flag: Boolean

    // CG-02 — explicit-value enum validates the wire value "active".
    @required
    status: Status

    // CG-02 — intEnum validates its integer values (1, 10).
    level: Level

    // CG-04 — @range on the target shape must constrain a JSON body number too.
    size: PageSize

    // CG-03 — union wire shape: restJson1 single-key object `{ "circle": {...} }`.
    shape: Geometry

    // RT-13 — a member targeting a @sensitive shape surfaces as a `sensitiveFields`
    // registry path.
    secret: Secret
}

@sensitive
string Secret

// CG-03 — restJson1 single-key union. The validator must accept `{ circle: ... }`,
// reject the old `{ type, value }` shape, and reject a two-variant object.
union Geometry {
    circle: Circle
    rectangle: Rectangle
    label: String
}

structure Circle {
    @required
    radius: Integer
}

structure Rectangle {
    @required
    width: Integer

    @required
    height: Integer
}

structure CreateThingOutput {
    @required
    item: ThingBody
}

// Explicit-value enum: member NAME != wire VALUE. The validator must accept the
// VALUE ("active"), not the name ("ACTIVE").
enum Status {
    ACTIVE = "active"
    INACTIVE = "inactive"
}

// intEnum: wire values are the integers 1 and 10.
intEnum Level {
    LOW = 1
    HIGH = 10
}

// CG-05 — catch-all map bindings: @httpQueryParams (all query params minus the
// explicit ones) and @httpPrefixHeaders (prefix-matched headers, prefix stripped).
@http(method: "GET", uri: "/maps/{id}", code: 200)
@readonly
@optionalAuth
operation EchoMaps {
    input: EchoMapsInput
    output: EchoMapsOutput
}

structure EchoMapsInput {
    @httpLabel
    @required
    id: String

    // Explicit query param — must be EXCLUDED from the @httpQueryParams catch-all.
    @httpQuery("known")
    known: String

    @httpQueryParams
    filters: StringMap

    @httpPrefixHeaders("x-meta-")
    meta: StringMap
}

structure EchoMapsOutput {
    @required
    id: String

    known: String
    filters: StringMap
    meta: StringMap
}

map StringMap {
    key: String
    value: String
}

// CG-04 — reusable constrained number: the @range lives on the SHAPE, not the
// member, so the emitter must resolve it member-then-target.
@range(min: 1, max: 50)
integer PageSize

// CG-09 — reserved-word member names and a struct whose NAME collides with a JS
// global must produce valid, non-shadowing TS (quoted keys; suffixed type name).
@http(method: "POST", uri: "/reserved", code: 200)
@optionalAuth
operation Reserved {
    input: ReservedInput
    output: ReservedOutput
}

structure ReservedInput {
    @httpPayload
    @required
    body: ReservedBody
}

structure ReservedBody {
    @required
    class: String

    default: String

    // member targeting a struct named `Number` (collides with the JS global)
    num: Number
}

structure ReservedOutput {
    @required
    ok: Boolean
}

// Struct NAME collides with the JS global `Number` → must be suffixed (NumberShape).
structure Number {
    @required
    amount: Integer
}

// CG-06 — output bindings: @httpResponseCode drives the status; output @httpHeader
// emits a response header; both are EXCLUDED from the JSON body.
@http(method: "POST", uri: "/widgets", code: 201)
@optionalAuth
operation MakeWidget {
    input: MakeWidgetInput
    output: MakeWidgetOutput
}

structure MakeWidgetInput {
    @httpPayload
    @required
    body: WidgetBody
}

structure WidgetBody {
    @required
    name: String
}

structure MakeWidgetOutput {
    @required
    id: String

    @httpResponseCode
    code: Integer

    @httpHeader("X-Widget-Location")
    location: String
}

// CG-10 — shape coverage: @timestampFormat, @uniqueItems, constrained map keys,
// bignum numeric strings, base64 blobs, and array @default.
@http(method: "POST", uri: "/shapes2", code: 200)
@optionalAuth
operation PutShapes {
    input: PutShapesInput
    output: PutShapesOutput
}

structure PutShapesInput {
    @httpPayload
    @required
    body: ShapesBody
}

structure ShapesBody {
    // CG-10(1) — explicit epoch-seconds format → a NUMBER, not an ISO string.
    @timestampFormat("epoch-seconds")
    epochTs: Timestamp

    // CG-10(2) — @uniqueItems rejects duplicates.
    tags: UniqueTags

    // CG-10(4) — bigInteger is a numeric string.
    bignum: BigInteger

    // CG-10(5) — non-streaming blob is base64.
    data: Blob

    // CG-10(3) — map key constrained to an enum.
    byStatus: StatusCountMap

    // CG-10(6) — array default must emit `.default([])`, not `.default(null)`.
    @default([])
    items: StringList
}

structure PutShapesOutput {
    @required
    ok: Boolean

    items: StringList
}

@uniqueItems
list UniqueTags {
    member: String
}

list StringList {
    member: String
}

map StatusCountMap {
    key: Status
    value: Integer
}
