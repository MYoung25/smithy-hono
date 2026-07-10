$version: "2.0"
namespace com.test

// CG-06 fixture: output members bound to @httpResponseCode (drives the status) and
// @httpHeader (response header) must be routed to the status/headers and EXCLUDED
// from the JSON body — not leaked as ordinary body fields.
service OutputBindingService {
    version: "1.0"
    operations: [
        MakeWidget
    ]
}

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
