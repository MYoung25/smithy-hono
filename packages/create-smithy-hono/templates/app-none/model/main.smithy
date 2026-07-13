$version: "2"

namespace com.example

use com.smithyhono#persisted

/// A minimal zero-handler CRUD service. The single @persisted resource `Task`
/// declares the full create/read/update/delete/list lifecycle; the codegen emits a
/// default DB-backed implementation (task.crud.gen.ts → createDefaultTaskOperations),
/// so this app ships NO hand-written operation code — just the model + a thin
/// createApp. Add operations by editing this file and re-running `npm run codegen`.
service TaskService {
    version: "2024-01-01"
    errors: [ValidationError]
    resources: [Task]
}

@persisted
resource Task {
    identifiers: { id: String }
    create: CreateTask              // POST   /tasks      (201)
    read: GetTask                   // GET    /tasks/{id} (200)
    update: UpdateTask              // PUT    /tasks/{id} (200)
    delete: DeleteTask              // DELETE /tasks/{id} (204)
    list: ListTasks                 // GET    /tasks      (200, paginated)
}

@documentation("Create a new Task. The server assigns id + timestamps.")
@http(method: "POST", uri: "/tasks", code: 201)
@optionalAuth
operation CreateTask {
    input: CreateTaskInput
    output: CreateTaskOutput
}

@documentation("Fetch a single Task by id. 404 TaskNotFound if absent.")
@http(method: "GET", uri: "/tasks/{id}", code: 200)
@optionalAuth
@readonly
operation GetTask {
    input: GetTaskInput
    output: GetTaskOutput
    errors: [TaskNotFound]
}

@documentation("Replace a Task's mutable fields by id. 404 TaskNotFound if absent.")
@http(method: "PUT", uri: "/tasks/{id}", code: 200)
@optionalAuth
@idempotent
operation UpdateTask {
    input: UpdateTaskInput
    output: UpdateTaskOutput
    errors: [TaskNotFound]
}

@documentation("Delete a Task by id. Idempotent. 404 TaskNotFound if absent.")
@http(method: "DELETE", uri: "/tasks/{id}", code: 204)
@optionalAuth
@idempotent
operation DeleteTask {
    input: DeleteTaskInput
    output: DeleteTaskOutput
    errors: [TaskNotFound]
}

@documentation("List Tasks, newest first, opaque-cursor pagination.")
@http(method: "GET", uri: "/tasks", code: 200)
@optionalAuth
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "items", pageSize: "maxResults")
operation ListTasks {
    input: ListTasksInput
    output: ListTasksOutput
}

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

/// The client-supplied write surface (no server-managed fields).
structure TaskBody {
    @required
    title: String

    done: Boolean
}

/// The stored/returned entity. Distinct from the resource name `Task`.
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
