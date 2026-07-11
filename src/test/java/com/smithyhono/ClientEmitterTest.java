package com.smithyhono;

import com.smithyhono.writers.ClientEmitter;
import com.smithyhono.writers.TypeScriptFileWriter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ClientEmitterTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    private static String emit(Model m, String serviceId, String group) {
        ModelIndex index = new ModelIndex(m, ShapeId.from(serviceId));
        List<OperationShape> ops = index.getOperations();
        List<StructureShape> errors = index.getServiceErrors();
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        new ClientEmitter(m, index).emitClientFile(group, group.toLowerCase(), ops, errors, Set.of(), writer);
        return writer.getContent();
    }

    // ── Factory + interface ──────────────────────────────────────────────────────

    @Test
    void emitsFactoryAndInterface() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        assertTrue(out.contains("export function createTodoClient(opts: TodoClientOptions = {}): TodoClient {"), out);
        assertTrue(out.contains("export interface TodoClient {"), out);
        assertTrue(out.contains("const _fetch: FetchLike = opts.fetch ?? globalThis.fetch"), out);
        assertTrue(out.contains("import { SmithyError } from './errors'"), out);
    }

    // ── Label path binding ───────────────────────────────────────────────────────

    @Test
    void labelMemberSubstitutedIntoPathNotColonForm() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        assertTrue(out.contains("/todos/${encodeURIComponent(String(input.id))}"), out);
        assertFalse(out.contains("/todos/:id"), "must use Smithy URI template, not Hono :id: " + out);
    }

    // ── Query binding ────────────────────────────────────────────────────────────

    @Test
    void queryMemberGuardedAndSet() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        assertTrue(out.contains("const _q = new URLSearchParams()"), out);
        assertTrue(out.contains("if (input.nextToken !== undefined) _q.set(\"nextToken\", String(input.nextToken))"), out);
        assertTrue(out.contains("${_qs ? '?' + _qs : ''}"), out);
    }

    // ── Payload body + content-type + status-agnostic success ────────────────────

    @Test
    void payloadBodyStringifiedWithContentType() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        assertTrue(out.contains("headers.set('content-type', 'application/json')"), out);
        assertTrue(out.contains("body: JSON.stringify(input.body)"), out);
        assertTrue(out.contains("return (await res.json()) as CreateTodoOutput"), out);
    }

    // ── 204 / void op reads no body ──────────────────────────────────────────────

    @Test
    void voidOpReturnsWithoutReadingJson() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        // DeleteTodo has no output → no `as ...Output` json read after its fetch.
        int del = out.indexOf("async DeleteTodo(");
        int next = out.indexOf("async ", del + 1);
        String slice = out.substring(del, next < 0 ? out.length() : next);
        assertTrue(slice.contains("if (!res.ok) _throwError"), slice);
        assertFalse(slice.contains("await res.json()"), "void op must not read a body: " + slice);
    }

    // ── Error mapping ────────────────────────────────────────────────────────────

    @Test
    void errorMappingSwitchesOnCodeWithDefaultSmithyError() {
        String out = emit(crudModel(), "test#TodoService", "Todo");
        assertTrue(out.contains("switch (b.code) {"), out);
        assertTrue(out.contains("case 'TodoNotFound': throw new TodoNotFound(message)"), out);
        assertTrue(out.contains("throw new SmithyError(message, status, status >= 500 ? 'server' : 'client')"), out);
        assertTrue(out.contains("import { TodoNotFound } from './todo.gen'"), out);
    }

    // ── Header + implicit body + queryParams/prefixHeaders (mixed bindings) ──────

    @Test
    void headerAndImplicitBodyAndCatchAllBindings() {
        String out = emit(mixedModel(), "test#MixedService", "Item");
        // @httpHeader
        assertTrue(out.contains("if (input.requestId !== undefined) headers.set(\"X-Request-Id\", String(input.requestId))"), out);
        // implicit body (PUT non-bound members), label excluded
        assertTrue(out.contains("body: JSON.stringify({ name: input.name, description: input.description })"), out);
        assertFalse(out.contains("id: input.id, name: input.name"), "label must not be in body: " + out);
        // @httpQueryParams catch-all
        assertTrue(out.contains("for (const [k, v] of Object.entries(input.extraParams ?? {})) { if (!_q.has(k)) _q.set(k, String(v)) }"), out);
        // @httpPrefixHeaders
        assertTrue(out.contains("for (const [k, v] of Object.entries(input.meta ?? {})) headers.set(\"x-meta-\" + k, String(v))"), out);
    }

    // ── Fixtures ─────────────────────────────────────────────────────────────────

    private static Model crudModel() {
        return modelFor(
            "service TodoService { version: \"1.0\", operations: [ListTodos, GetTodo, CreateTodo, DeleteTodo], errors: [TodoNotFound] }\n" +
            "@error(\"client\") @httpError(404) structure TodoNotFound { @required message: String }\n" +
            "@http(method: \"GET\", uri: \"/todos\", code: 200) @readonly @optionalAuth operation ListTodos { input: ListTodosInput, output: ListTodosOutput }\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200) @readonly @optionalAuth operation GetTodo { input: GetTodoInput, output: GetTodoOutput }\n" +
            "@http(method: \"POST\", uri: \"/todos\", code: 201) @optionalAuth operation CreateTodo { input: CreateTodoInput, output: CreateTodoOutput }\n" +
            "@http(method: \"DELETE\", uri: \"/todos/{id}\", code: 204) @optionalAuth operation DeleteTodo { input: DeleteTodoInput }\n" +
            "structure ListTodosInput { @httpQuery(\"nextToken\") nextToken: String }\n" +
            "structure ListTodosOutput { @required items: TodoList }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { @required item: Todo }\n" +
            "structure CreateTodoInput { @httpPayload @required body: CreateTodoBody }\n" +
            "structure CreateTodoBody { @required title: String }\n" +
            "structure CreateTodoOutput { @required item: Todo }\n" +
            "structure DeleteTodoInput { @httpLabel @required id: String }\n" +
            "structure Todo { @required id: String, @required title: String }\n" +
            "list TodoList { member: Todo }");
    }

    private static Model mixedModel() {
        return modelFor(
            "service MixedService { version: \"1.0\", operations: [UpdateItem, SearchItems, GetItem] }\n" +
            "@http(method: \"GET\", uri: \"/items/{id}\", code: 200) @readonly @optionalAuth operation GetItem { input: GetItemInput, output: GetItemOutput }\n" +
            "@http(method: \"GET\", uri: \"/items\", code: 200) @readonly @optionalAuth operation SearchItems { input: SearchItemsInput, output: SearchItemsOutput }\n" +
            "@http(method: \"PUT\", uri: \"/items/{id}\", code: 200) @optionalAuth operation UpdateItem { input: UpdateItemInput, output: UpdateItemOutput }\n" +
            "structure GetItemInput { @httpLabel @required id: String, @httpHeader(\"X-Request-Id\") requestId: String }\n" +
            "structure GetItemOutput { @required item: Item }\n" +
            "structure SearchItemsInput { @httpQuery(\"q\") q: String, @httpQueryParams extraParams: StringMap, @httpPrefixHeaders(\"x-meta-\") meta: StringMap }\n" +
            "structure SearchItemsOutput { @required items: ItemList }\n" +
            "structure UpdateItemInput { @httpLabel @required id: String, name: String, description: String }\n" +
            "structure UpdateItemOutput { @required item: Item }\n" +
            "map StringMap { key: String, value: String }\n" +
            "structure Item { @required id: String, @required name: String }\n" +
            "list ItemList { member: Item }");
    }
}
