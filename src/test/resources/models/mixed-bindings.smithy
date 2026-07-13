$version: "2.0"
namespace com.test

use com.smithyhono#cost
use com.smithyhono#requiresAuth
use com.smithyhono#sigv4Hmac

service MixedBindingsService {
    version: "1.0"
    operations: [
        CreateItem
        GetItem
        SearchItems
        UpdateItem
    ]
}

@http(method: "GET", uri: "/items/{id}", code: 200)
@readonly
@optionalAuth
operation GetItem {
    input: GetItemInput
    output: GetItemOutput
}

structure GetItemInput {
    @httpLabel
    @required
    id: String

    @httpHeader("X-Request-Id")
    requestId: String
}

structure GetItemOutput {
    @required
    item: Item
}

@http(method: "GET", uri: "/items", code: 200)
@readonly
@optionalAuth
operation SearchItems {
    input: SearchItemsInput
    output: SearchItemsOutput
}

structure SearchItemsInput {
    @httpQuery("q")
    q: String

    @httpQuery("limit")
    limit: Integer

    @httpQuery("page")
    page: Integer

    // CG-05 — catch-all of all query params except the explicit q/limit/page above.
    @httpQueryParams
    extraParams: StringMap

    // CG-05 — headers matching the prefix, prefix stripped.
    @httpPrefixHeaders("x-meta-")
    meta: StringMap
}

map StringMap {
    key: String
    value: String
}

structure SearchItemsOutput {
    @required
    items: ItemList

    total: Integer
}

@http(method: "POST", uri: "/items", code: 201)
@cost(value: 3)
@requiresAuth(permission: "items.write")
operation CreateItem {
    input: CreateItemInput
    output: CreateItemOutput
}

structure CreateItemInput {
    @httpPayload
    @required
    body: CreateItemBody

    @httpHeader("X-Idempotency-Key")
    idempotencyKey: String
}

structure CreateItemBody {
    @required
    @length(min: 1, max: 120)
    name: String

    description: String
}

structure CreateItemOutput {
    @required
    item: Item
}

@http(method: "PUT", uri: "/items/{id}", code: 200)
@sigv4Hmac
operation UpdateItem {
    input: UpdateItemInput
    output: UpdateItemOutput
}

structure UpdateItemInput {
    @httpLabel
    @required
    id: String

    name: String

    description: String
}

structure UpdateItemOutput {
    @required
    item: Item
}

structure Item {
    @required
    id: String

    @required
    name: String

    description: String
}

list ItemList {
    member: Item
}
