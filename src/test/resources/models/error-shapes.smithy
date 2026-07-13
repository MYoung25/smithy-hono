$version: "2.0"
namespace com.test

service ErrorShapeService {
    version: "1.0"
    operations: [CreateResource, GetResource]
    errors: [ServiceUnavailableError, ValidationError, ThrottlingException]
}

@http(method: "GET", uri: "/resources/{id}", code: 200)
@optionalAuth
operation GetResource {
    input: GetResourceInput
    output: GetResourceOutput
    errors: [NotFoundError, ForbiddenError]
}

structure GetResourceInput {
    @httpLabel
    @required
    id: String
}

structure GetResourceOutput {
    @required
    id: String

    @required
    name: String
}

@http(method: "POST", uri: "/resources", code: 201)
@optionalAuth
operation CreateResource {
    input: CreateResourceInput
    output: CreateResourceOutput
    errors: [ConflictError]
}

structure CreateResourceInput {
    @required
    name: String
}

structure CreateResourceOutput {
    @required
    id: String

    @required
    name: String
}

@error("client")
@httpError(404)
structure NotFoundError {
    message: String
}

@error("client")
@httpError(403)
structure ForbiddenError {
    message: String
}

@error("client")
@httpError(409)
structure ConflictError {
    message: String
}

@error("server")
@httpError(503)
structure ServiceUnavailableError {
    message: String
    retryAfter: Integer
}

@error("client")
@httpError(429)
@retryable(throttling: true)
structure ThrottlingException {
    message: String
}

@error("client")
@httpError(400)
structure ValidationError {
    message: String
    field: String
}
