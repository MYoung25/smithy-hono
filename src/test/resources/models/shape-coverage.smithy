$version: "2.0"
namespace com.test

// CG-10 fixture: @timestampFormat, @uniqueItems, constrained map keys, bignum
// numeric strings, base64 blobs, and array/object @default — a committed record of
// the emitted Zod for each shape feature.
service ShapeCoverageService {
    version: "1.0"
    operations: [
        PutShapes
    ]
}

@http(method: "POST", uri: "/shapes", code: 200)
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
    @timestampFormat("epoch-seconds")
    epochTs: Timestamp

    @timestampFormat("date-time")
    isoTs: Timestamp

    tags: UniqueTags

    bignum: BigInteger

    amount: BigDecimal

    data: Blob

    byStatus: StatusCountMap

    @default([])
    items: StringList

    @default("a\"quoted\" value")
    label: String

    // RT-13 — a member targeting a @sensitive shape → a `sensitiveFields` reg path.
    secret: SecretToken
}

@sensitive
string SecretToken

structure PutShapesOutput {
    @required
    ok: Boolean
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

enum Status {
    ACTIVE = "active"
    INACTIVE = "inactive"
}
