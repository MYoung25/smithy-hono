$version: "2.0"
namespace com.test

use com.smithyhono#mcpPrompts

// Exercises the @mcpPrompts emitter (Plan 14, §12) at BOTH attachment points:
//   - a service-level prompt (name required, args exactly as declared)
//   - an operation-anchored prompt on CreateNote with `arguments` OMITTED, so the
//     emitter defaults the name to `create-note`, derives the args from CreateNoteInput's
//     members, and appends the `(uses the CreateNote tool)` tool reference.
@mcpPrompts([
    {
        name: "summarize-notes"
        description: "Summarize the current notes."
        arguments: [{ name: "tone", description: "Desired tone", required: false }]
        template: "List the notes (call the list-notes tool) and summarize them. Tone: {tone}."
    }
])
service NoteService {
    version: "1.0"
    operations: [
        CreateNote
        ListNotes
    ]
}

@documentation("Create a new note.")
@mcpPrompts([
    {
        description: "Draft a note from free text."
        template: "Create a note from: {body}. Keep it concise."
    }
])
@http(method: "POST", uri: "/notes", code: 201)
@optionalAuth
operation CreateNote {
    input: CreateNoteInput
    output: CreateNoteOutput
}

@http(method: "GET", uri: "/notes", code: 200)
@optionalAuth
@readonly
operation ListNotes {
    input: ListNotesInput
    output: ListNotesOutput
}

structure CreateNoteInput {
    @required
    @documentation("The note text.")
    @httpPayload
    body: String
}

structure CreateNoteOutput {
    @required
    id: String
}

structure ListNotesInput {}

structure ListNotesOutput {
    @required
    items: NoteList
}

list NoteList {
    member: String
}
