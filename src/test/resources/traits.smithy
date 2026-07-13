$version: "2.0"

namespace com.smithyhono

@trait(selector: "operation")
structure requiresAuth {
    permission: String
}

@trait(selector: "structure")
structure sseEvent {
    @required
    eventType: String
}

@trait(selector: "operation")
structure cost {
    @required
    value: Integer
}

@trait(selector: "operation")
structure sigv4Hmac {}

@trait(selector: "operation")
structure sseStream {}

@trait(selector: "resource")
structure persisted {
    table: String
    timestamps: Boolean
    softDelete: Boolean
    optimisticConcurrency: Boolean
    ownerField: String
    tenantField: String
    allowUnscoped: Boolean
    indexes: PersistedIndexList
}

@trait(selector: "resource [trait|com.smithyhono#persisted]")
structure live {
    keyMember: String
    eventType: String
    lifecycleEvents: Boolean
    pushRecords: Boolean
}

@private
list PersistedIndexList {
    member: PersistedIndex
}

@private
structure PersistedIndex {
    @required
    name: String

    @required
    key: String
}

@trait(selector: ":is(service, operation)")
list mcpPrompts {
    member: McpPrompt
}

@private
structure McpPrompt {
    name: String
    description: String
    arguments: McpPromptArgumentList

    @required
    template: String
}

@private
list McpPromptArgumentList {
    member: McpPromptArgument
}

@private
structure McpPromptArgument {
    @required
    name: String

    description: String
    required: Boolean
}
