$version: "2"

namespace com.example.todo

use com.smithyhono#requiresAuth

service TodoService {
    version: "2024-01-01"
    errors: [ValidationError, ThrottlingException]
    operations: [ListTodos, GetTodo, CreateTodo, DeleteTodo]
}

// ── Operations ────────────────────────────────────────────────────────────────

@http(method: "GET", uri: "/todos", code: 200)
@readonly
@optionalAuth
operation ListTodos {
    input: ListTodosInput
    output: ListTodosOutput
}

@requiresAuth(permission: "todos.read")
@http(method: "GET", uri: "/todos/{id}", code: 200)
@readonly
operation GetTodo {
    input: GetTodoInput
    output: GetTodoOutput
    errors: [TodoNotFound]
}

@requiresAuth(permission: "todos.write")
@http(method: "POST", uri: "/todos", code: 201)
@idempotent
operation CreateTodo {
    input: CreateTodoInput
    output: CreateTodoOutput
}

@requiresAuth(permission: "todos.write")
@http(method: "DELETE", uri: "/todos/{id}", code: 204)
@idempotent
operation DeleteTodo {
    input: DeleteTodoInput
    output: DeleteTodoOutput
    errors: [TodoNotFound]
}

// ── Input / Output structures ─────────────────────────────────────────────────

structure ListTodosInput {
    @httpQuery("nextToken")
    nextToken: String
}

structure ListTodosOutput {
    @required
    items: TodoList

    nextToken: String
}

structure GetTodoInput {
    @required
    @httpLabel
    id: String
}

structure GetTodoOutput {
    @required
    item: Todo
}

structure CreateTodoInput {
    @required
    @httpPayload
    body: CreateTodoBody
}

structure CreateTodoBody {
    @required
    title: String

    done: Boolean
}

structure CreateTodoOutput {
    @required
    item: Todo
}

structure DeleteTodoInput {
    @required
    @httpLabel
    id: String
}

structure DeleteTodoOutput {}

// ── Domain shapes ─────────────────────────────────────────────────────────────

structure Todo {
    @required
    id: String

    @required
    title: String

    @required
    done: Boolean

    @required
    createdAt: Timestamp
}

list TodoList {
    member: Todo
}

// ── Error shapes ──────────────────────────────────────────────────────────────

@error("client")
@httpError(404)
structure TodoNotFound {
    @required
    message: String
}

@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
}

// Thrown by the rate limiter (Phase S7) on a 429 — modeled so generated clients
// back off and retry correctly (RATE-02). The runtime returns this wire shape.
@error("client")
@httpError(429)
@retryable(throttling: true)
structure ThrottlingException {
    @required
    message: String
}
