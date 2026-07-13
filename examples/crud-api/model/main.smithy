$version: "2"

namespace com.example.crud

use com.smithyhono#persisted
use com.smithyhono#mcpPrompts

// A zero-handler CRUD service (Plan 13, P4). The single @persisted resource Task
// declares the full create/read/update/delete/list lifecycle; the codegen emits a
// default DB-backed implementation (task.crud.gen.ts → createDefaultTaskOperations)
// so the example app ships NO implementation.ts.
//
// The @mcpPrompts (Plan 14, §12) declares one service-wide prompt; CreateTask (below)
// carries a second, operation-anchored prompt whose name + arguments are defaulted.
@mcpPrompts([
    {
        name: "triage-tasks"
        description: "Review the open tasks and propose a prioritization."
        arguments: [{ name: "focus", description: "Area to prioritize", required: false }]
        template: "List the current tasks (call the list-tasks tool), then propose a priority order. Focus on: {focus}."
    }
])
service TaskService {
    version: "2024-01-01"
    errors: [ValidationError]
    resources: [Task]
}

// Bare @persisted = all config defaulted (MVP path). The entity data shape is named
// distinctly from the resource (Smithy forbids reusing the resource's name).
@persisted
resource Task {
    identifiers: { id: String }
    create: CreateTask              // POST   /tasks      (201)
    read: GetTask                   // GET    /tasks/{id} (200) — binds @httpError(404)
    update: UpdateTask              // PUT    /tasks/{id} (200) — binds @httpError(404)
    delete: DeleteTask              // DELETE /tasks/{id} (204) — binds @httpError(404)
    list: ListTasks                 // GET    /tasks      (200) — @paginated
}

// ── Lifecycle operations ────────────────────────────────────────────────────────

@documentation("Create a new Task. The server assigns the id and timestamps; provide title (required) and optional done flag.")
@mcpPrompts([
    {
        description: "Draft a new task from a free-text note."
        template: "Create a task from this note: {body}. Set a sensible title; leave done=false."
    }
])
@http(method: "POST", uri: "/tasks", code: 201)
@optionalAuth
operation CreateTask {
    input: CreateTaskInput
    output: CreateTaskOutput
}

@documentation("Fetch a single Task by its id. Returns TaskNotFound (404) if no Task with that id exists.")
@http(method: "GET", uri: "/tasks/{id}", code: 200)
@optionalAuth
@readonly
operation GetTask {
    input: GetTaskInput
    output: GetTaskOutput
    errors: [TaskNotFound]
}

@documentation("Replace a Task's mutable fields (title, done) by id. Returns TaskNotFound (404) if the Task does not exist.")
@http(method: "PUT", uri: "/tasks/{id}", code: 200)
@optionalAuth
@idempotent
operation UpdateTask {
    input: UpdateTaskInput
    output: UpdateTaskOutput
    errors: [TaskNotFound]
}

@documentation("Delete a Task by id. Idempotent. Returns TaskNotFound (404) if the Task does not exist.")
@http(method: "DELETE", uri: "/tasks/{id}", code: 204)
@optionalAuth
@idempotent
operation DeleteTask {
    input: DeleteTaskInput
    output: DeleteTaskOutput
    errors: [TaskNotFound]
}

@documentation("List Tasks, newest first, with opaque-cursor pagination via nextToken and maxResults (1-100).")
@http(method: "GET", uri: "/tasks", code: 200)
@optionalAuth
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
operation ListTasks {
    input: ListTasksInput
    output: ListTasksOutput
}

// ── Input / Output structures ─────────────────────────────────────────────────

structure CreateTaskInput {
    @required
    @httpPayload
    body: TaskBody
}

structure CreateTaskOutput {
    @required
    item: TaskData
}

structure GetTaskInput {
    @required
    @httpLabel
    id: String
}

structure GetTaskOutput {
    @required
    item: TaskData
}

structure UpdateTaskInput {
    @required
    @httpLabel
    id: String

    @required
    @httpPayload
    body: TaskBody
}

structure UpdateTaskOutput {
    @required
    item: TaskData
}

structure DeleteTaskInput {
    @required
    @httpLabel
    id: String
}

structure DeleteTaskOutput {}

structure ListTasksInput {
    @httpQuery("nextToken")
    nextToken: String

    @httpQuery("maxResults")
    @range(min: 1, max: 100)
    maxResults: Integer
}

structure ListTasksOutput {
    @required
    items: TaskList

    nextToken: String
}

// ── Domain shapes ─────────────────────────────────────────────────────────────

// The client-supplied write surface (no server-managed fields).
structure TaskBody {
    @required
    title: String

    done: Boolean
}

// The stored/returned entity. Distinct from the resource name `Task`. Declares
// createdAt/updatedAt so the default impl auto-stamps timestamps (default ON).
structure TaskData {
    @required
    id: String

    @required
    title: String

    done: Boolean

    @required
    createdAt: Timestamp

    @required
    updatedAt: Timestamp
}

list TaskList {
    member: TaskData
}

// ── Error shapes ──────────────────────────────────────────────────────────────

@error("client")
@httpError(404)
structure TaskNotFound {
    @required
    message: String
}

@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
}
