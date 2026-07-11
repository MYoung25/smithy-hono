$version: "2.0"
namespace com.test

// CG-03 fixture: a union used both as a direct operation-input member (exercises
// toTsType(UNION)) and inside a payload struct. restJson1 serializes a union as a
// single-key object `{ "circle": {...} }`, never `{ type, value }`.
service UnionService {
    version: "1.0"
    operations: [
        PutShape
    ]
}

@http(method: "POST", uri: "/shapes", code: 200)
@optionalAuth
operation PutShape {
    input: PutShapeInput
    output: PutShapeOutput
}

structure PutShapeInput {
    // Direct input-member union — the operations interface input type must compile.
    @required
    shape: Geometry
}

structure PutShapeOutput {
    @required
    shape: Geometry
}

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
