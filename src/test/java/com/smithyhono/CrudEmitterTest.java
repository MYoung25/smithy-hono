package com.smithyhono;

import com.smithyhono.writers.CrudEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ShapeId;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Plan 13 (P3): golden test for {@link CrudEmitter} — the default DB-backed CRUD factory.
 */
class CrudEmitterTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#persisted\n";

    /** A valid bare @persisted Todo resource (entity = TodoData, wrapper = item / items). */
    private static String validBareTodo() {
        return "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  create: CreateTodo\n" +
            "  read: GetTodo\n" +
            "  update: UpdateTodo\n" +
            "  delete: DeleteTodo\n" +
            "  list: ListTodos\n" +
            "}\n" +
            "@http(method: \"POST\", uri: \"/todos\", code: 201)\n@optionalAuth\n" +
            "operation CreateTodo { input: CreateTodoInput, output: CreateTodoOutput }\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation UpdateTodo { input: UpdateTodoInput, output: UpdateTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"DELETE\", uri: \"/todos/{id}\", code: 204)\n@optionalAuth\n@idempotent\n" +
            "operation DeleteTodo { input: DeleteTodoInput, errors: [TodoNotFound] }\n" +
            "@http(method: \"GET\", uri: \"/todos\", code: 200)\n@optionalAuth\n@readonly\n" +
            "@paginated(inputToken: \"nextToken\", outputToken: \"nextToken\", items: \"items\", pageSize: \"maxResults\")\n" +
            "operation ListTodos { input: ListTodosInput, output: ListTodosOutput }\n" +
            "structure CreateTodoInput { @required title: String }\n" +
            "structure CreateTodoOutput { item: TodoData }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure UpdateTodoInput { @httpLabel @required id: String, title: String }\n" +
            "structure UpdateTodoOutput { item: TodoData }\n" +
            "structure DeleteTodoInput { @httpLabel @required id: String }\n" +
            "structure ListTodosInput { @httpQuery(\"nextToken\") nextToken: String, @httpQuery(\"maxResults\") maxResults: Integer }\n" +
            "structure ListTodosOutput { items: TodoList, nextToken: String }\n" +
            "list TodoList { member: TodoData }\n" +
            "structure TodoData { @required id: String, title: String, createdAt: Timestamp, updatedAt: Timestamp }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
    }

    private Model assemble(String body) throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", HEADER + body)
                .assemble()
                .unwrap();
    }

    private record Emitted(Optional<String> fileName, String content, List<String> warnings) {}

    private Emitted emit(String body) throws Exception {
        Model model = assemble(body);
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));
        ResourceShape todo = model.expectShape(ShapeId.from("com.test#Todo"), ResourceShape.class);

        // Capture the emitter's fallback warnings via the JUL logger.
        Logger logger = Logger.getLogger(CrudEmitter.class.getName());
        List<String> warnings = new java.util.ArrayList<>();
        Handler handler = new Handler() {
            @Override public void publish(LogRecord r) {
                if (r.getLevel().intValue() >= Level.WARNING.intValue()) warnings.add(r.getMessage());
            }
            @Override public void flush() {}
            @Override public void close() {}
        };
        logger.addHandler(handler);
        try {
            Path tmp = Files.createTempDirectory("crud-test");
            FileManifest manifest = FileManifest.create(tmp);
            CrudEmitter emitter = new CrudEmitter(model, index, "@smithy-hono/security-core", 100, 25);
            Optional<String> fileName = emitter.emit(todo, "Todo", "todo", manifest);
            String content = fileName.isPresent()
                ? Files.readString(tmp.resolve(fileName.get())) : "";
            return new Emitted(fileName, content, warnings);
        } finally {
            logger.removeHandler(handler);
        }
    }

    @Test
    void emitsFactoryForBareTodo() throws Exception {
        Emitted e = emit(validBareTodo());
        assertEquals(Optional.of("todo.crud.gen.ts"), e.fileName());
        String out = e.content();

        // Factory signature + return type = the route file's interface.
        assertTrue(out.contains("export function createDefaultTodoOperations("), out);
        assertTrue(out.contains("store: DataStore<TodoData>, hooks?: TodoHooks,"), out);
        assertTrue(out.contains("): TodoOperations {"), out);

        // Imports from data-core + the route .gen file.
        assertTrue(out.contains("import type { DataStore, DataScope } from '@smithy-hono/data-core'"), out);
        assertTrue(out.contains("from './todo.gen'"), out);
        assertTrue(out.contains("import type { Context } from 'hono'"), out);
        assertTrue(out.contains("import type { SecurityEnv } from '@smithy-hono/security-core'"), out);
    }

    @Test
    void bareePersistedEmitsMinimalFactoryJsDoc() throws Exception {
        // Bare @persisted (all defaults) → the JSDoc says the store needs no special options
        // and lists no @persisted(...) config to mirror.
        String out = emit(validBareTodo()).content();
        assertTrue(out.contains(" * Default CRUD operations for Todo, backed by a DataStore."), out);
        assertTrue(out.contains("modeled with a bare `@persisted` (all defaults)"), out);
        // Minimal form: no config restatement, no store-options example.
        assertFalse(out.contains("modeled `@persisted("), out);
        assertFalse(out.contains("createXDataStore"), out);
    }

    @Test
    void configuredPersistedEmitsConfigInFactoryJsDoc() throws Exception {
        // softDelete + a declared index → the JSDoc restates the config and tells the consumer
        // to build the store with matching options (the index KEY, not its name).
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(softDelete: true, table: \"todos\", indexes: [{ name: \"byOwner\", key: \"ownerId\" }])\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        // Config restated (index reported by KEY field, not name).
        assertTrue(out.contains("modeled `@persisted(softDelete: true, table: \"todos\", indexes: [ownerId])`"), out);
        // Store-construction example uses quoted index keys + matching options.
        assertTrue(out.contains("{ softDelete: true, table: \"todos\", indexes: [\"ownerId\"] }"), out);
        assertTrue(out.contains("store-construction concerns — this factory does not configure the store."), out);
        // byOwner is the index NAME and must not leak into the doc.
        assertFalse(out.contains("byOwner"), out);
    }

    @Test
    void verbsBindTheRightStoreMethods() throws Exception {
        String out = emit(validBareTodo()).content();

        // create — server-assigned id + store.create
        assertTrue(out.contains("async CreateTodo(input, c) {"), out);
        assertTrue(out.contains("const id = crypto.randomUUID()"), out);
        assertTrue(out.contains("await store.create(id, entity, scope)"), out);

        // read — store.get + 404 throw + sole-member wrapper "item"
        assertTrue(out.contains("async GetTodo(input, c) {"), out);
        assertTrue(out.contains("const item = await store.get(input.id, scopeFrom(c))"), out);
        assertTrue(out.contains("throw new TodoNotFound("), out);
        assertTrue(out.contains("return { item }"), out);

        // update — get-then-update, undefined version (oc off)
        assertTrue(out.contains("async UpdateTodo(input, c) {"), out);
        assertTrue(out.contains("await store.update(input.id, merged, undefined, scope)"), out);
        assertTrue(out.contains("return { item: saved }"), out);

        // delete — store.delete + 404 on miss
        assertTrue(out.contains("async DeleteTodo(input, c) {"), out);
        assertTrue(out.contains("const existed = await store.delete(input.id, undefined, scopeFrom(c))"), out);

        // list — store.list + paginated member names (items / nextToken / maxResults)
        assertTrue(out.contains("async ListTodos(input, c) {"), out);
        assertTrue(out.contains("cursor: input.nextToken, limit: Math.min(input.maxResults ?? 25, 100)"), out);
        assertTrue(out.contains("return { items: items, nextToken: page.cursor }"), out);
    }

    @Test
    void emitsTimestampsWhenEntityDeclaresThem() throws Exception {
        String out = emit(validBareTodo()).content();
        assertTrue(out.contains("const now = new Date().toISOString()"), out);
        assertTrue(out.contains("createdAt: now"), out);
        assertTrue(out.contains("updatedAt: now"), out);
    }

    @Test
    void scopeFromIsEmptyWithoutOwnerOrTenant() throws Exception {
        String out = emit(validBareTodo()).content();
        // No ownerField/tenantField declared → scopeFrom returns {}.
        assertTrue(out.contains("function scopeFrom(c?: Context<SecurityEnv>): DataScope {"), out);
        assertTrue(out.contains("  return {}"), out);
        assertFalse(out.contains("ownerId: p?.id"), out);
    }

    @Test
    void scopeFromEmitsOnlyDeclaredKeys() throws Exception {
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(ownerField: \"ownerId\")\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        assertTrue(out.contains("const p = c?.get('principal')"), out);
        // CG fail-closed: scopeFrom throws on a missing principal, so the owner key
        // reads p.id (non-optional) rather than p?.id.
        assertTrue(out.contains("if (!p) throw new Error("), out);
        assertTrue(out.contains("return { ownerId: p.id }"), out);
        assertFalse(out.contains("tenantId:"), out);
    }

    @Test
    void putBindingUsesClientIdAndUnconditionalUpsert() throws Exception {
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  put: PutTodo\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation PutTodo { input: PutTodoInput, output: PutTodoOutput }\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure PutTodoInput { @httpLabel @required id: String, title: String }\n" +
            "structure PutTodoOutput { item: TodoData }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String, title: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        assertTrue(out.contains("async PutTodo(input, c) {"), out);
        assertTrue(out.contains("const id = input.id"), out);
        assertTrue(out.contains("await store.put(id, entity, scope)"), out);
        assertFalse(out.contains("crypto.randomUUID()"), out);
    }

    @Test
    void optimisticConcurrencyRethrowsConflictAs409() throws Exception {
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(optimisticConcurrency: true)\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "  update: UpdateTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation UpdateTodo { input: UpdateTodoInput, output: UpdateTodoOutput, errors: [TodoNotFound, TodoConflict] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure UpdateTodoInput { @httpLabel @required id: String, title: String }\n" +
            "structure UpdateTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String, title: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n" +
            "@error(\"client\")\n@httpError(409)\nstructure TodoConflict { message: String }\n";
        String out = emit(body).content();
        assertTrue(out.contains("import { OptimisticConflictError } from '@smithy-hono/data-core'"), out);
        assertTrue(out.contains("await store.update(input.id, merged, existing.version, scope)"), out);
        assertTrue(out.contains("if (e instanceof OptimisticConflictError)"), out);
        assertTrue(out.contains("throw new TodoConflict("), out);
    }

    @Test
    void fallbackWhenOutputNotSingleWrapper() throws Exception {
        // GetTodoOutput has TWO members → not a plain single-member wrapper → fallback.
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData, extra: String }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        Emitted e = emit(body);
        assertEquals(Optional.empty(), e.fileName(), "no factory emitted on fallback");
        assertTrue(e.warnings().stream().anyMatch(w -> w.contains("skipping default CRUD impl")
                && w.contains("Todo")),
            "a fallback warning should be logged. Warnings: " + e.warnings());
    }

    @Test
    void crudApiExampleModelEmitsValidFactory() throws Exception {
        // Plan 13 (P4): the checked-in examples/crud-api model must auto-implement.
        // It differs from the inline fixtures by binding @httpPayload `body` on BOTH
        // create AND update (the inline UpdateTodo spreads flat input), so this guards
        // the body-spread derivation on the update path the example actually ships.
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        Path modelFile = Path.of(System.getProperty("user.dir"))
                .resolve("examples/crud-api/model/main.smithy");
        assertTrue(Files.exists(modelFile), "crud-api example model not found: " + modelFile);

        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addImport(modelFile.toUri().toURL())
                .assemble()
                .unwrap();
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.example.crud#TaskService"));
        ResourceShape task = model.expectShape(
                ShapeId.from("com.example.crud#Task"), ResourceShape.class);

        Path tmp = Files.createTempDirectory("crud-api-golden");
        FileManifest manifest = FileManifest.create(tmp);
        CrudEmitter emitter = new CrudEmitter(model, index, "@smithy-hono/security-core", 100, 25);
        Optional<String> fileName = emitter.emit(task, "Task", "task", manifest);

        assertEquals(Optional.of("task.crud.gen.ts"), fileName,
                "the crud-api Task resource must emit a default factory (no fallback)");
        String out = Files.readString(tmp.resolve(fileName.get()));

        assertTrue(out.contains("export function createDefaultTaskOperations("), out);
        assertTrue(out.contains("store: DataStore<TaskData>, hooks?: TaskHooks,"), out);
        assertTrue(out.contains("): TaskOperations {"), out);

        // create + update both pull the body from the @httpPayload `body` member.
        assertTrue(out.contains("async CreateTask(input, c) {"), out);
        assertTrue(out.contains("const entity = { ...input.body,"), out);
        assertTrue(out.contains("await store.create(id, entity, scope)"), out);
        assertTrue(out.contains("async UpdateTask(input, c) {"), out);
        assertTrue(out.contains("const merged = { ...existing, ...input.body,"), out);

        // read/delete throw the modeled 404; list uses the paginated member names.
        assertTrue(out.contains("throw new TaskNotFound("), out);
        assertTrue(out.contains("cursor: input.nextToken, limit: Math.min(input.maxResults ?? 25, 100)"), out);
        assertTrue(out.contains("return { items: items, nextToken: page.cursor }"), out);
    }

    @Test
    void implicitBodyDoesNotPersistTransportMembers() throws Exception {
        // No @httpPayload member → the body is spread from the input. The op also binds a
        // transport-only @httpQuery member (create) and an @httpHeader member (update); neither
        // must leak into the persisted entity. The @httpLabel id is likewise stripped (it is
        // re-applied explicitly as `id`).
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  create: CreateTodo\n" +
            "  read: GetTodo\n" +
            "  update: UpdateTodo\n" +
            "}\n" +
            "@http(method: \"POST\", uri: \"/todos\", code: 201)\n@optionalAuth\n" +
            "operation CreateTodo { input: CreateTodoInput, output: CreateTodoOutput }\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation UpdateTodo { input: UpdateTodoInput, output: UpdateTodoOutput, errors: [TodoNotFound] }\n" +
            "structure CreateTodoInput { @required title: String, @httpQuery(\"dryRun\") dryRun: Boolean }\n" +
            "structure CreateTodoOutput { item: TodoData }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure UpdateTodoInput { @httpLabel @required id: String, title: String, @httpHeader(\"If-Match\") ifMatch: String }\n" +
            "structure UpdateTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String, title: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();

        // create — the @httpQuery `dryRun` (and @httpLabel-free input) is destructured out; the
        // persisted entity spreads only the remaining body, NOT `...input`.
        assertTrue(out.contains("const { dryRun, ...body } = input"), out);
        assertTrue(out.contains("const entity = { ...body, id: id,"), out);
        assertFalse(out.contains("const entity = { ...input,"), out);

        // update — the @httpLabel `id` and @httpHeader `ifMatch` are stripped; merged spreads
        // only the body, never the raw input.
        assertTrue(out.contains("const { id, ifMatch, ...body } = input"), out);
        assertTrue(out.contains("const merged = { ...existing, ...body, id: input.id"), out);
        assertFalse(out.contains("const merged = { ...existing, ...input,"), out);

        // FIX 2 — no optimisticConcurrency and the factory returns plain literals, so neither
        // OptimisticConflictError nor any output-wrapper type is imported.
        assertFalse(out.contains("OptimisticConflictError"), out);
        assertFalse(out.contains("CreateTodoOutput"), out);
        assertFalse(out.contains("UpdateTodoOutput"), out);
        assertFalse(out.contains("GetTodoOutput"), out);
    }

    @Test
    void listWiresDeclaredIndexQueryParamIntoFilter() throws Exception {
        // Fix 4 — the resource declares a byGame index (key gameId) and the list op has a
        // matching @httpQuery("gameId") member, so the default list handler builds an equality
        // filter from it and threads it into store.list.
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(indexes: [{ name: \"byGame\", key: \"gameId\" }])\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "  list: ListTodos\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"GET\", uri: \"/todos\", code: 200)\n@optionalAuth\n@readonly\n" +
            "@paginated(inputToken: \"nextToken\", outputToken: \"nextToken\", items: \"items\", pageSize: \"maxResults\")\n" +
            "operation ListTodos { input: ListTodosInput, output: ListTodosOutput }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure ListTodosInput { @httpQuery(\"gameId\") gameId: String, @httpQuery(\"nextToken\") nextToken: String, @httpQuery(\"maxResults\") maxResults: Integer }\n" +
            "structure ListTodosOutput { items: TodoList, nextToken: String }\n" +
            "list TodoList { member: TodoData }\n" +
            "structure TodoData { @required id: String, gameId: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        assertTrue(out.contains("const filter: Record<string, string | number | boolean> = {}"), out);
        assertTrue(out.contains("if (input.gameId !== undefined) filter.gameId = input.gameId"), out);
        assertTrue(out.contains("limit: Math.min(input.maxResults ?? 25, 100), filter }"), out);
    }

    @Test
    void listWithoutDeclaredIndexIsUnfiltered() throws Exception {
        // Fix 4 — no @persisted index → the list handler keeps the unfiltered store.list call,
        // even if the op declares query members (here gameId is just a plain query param).
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "  list: ListTodos\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"GET\", uri: \"/todos\", code: 200)\n@optionalAuth\n@readonly\n" +
            "@paginated(inputToken: \"nextToken\", outputToken: \"nextToken\", items: \"items\", pageSize: \"maxResults\")\n" +
            "operation ListTodos { input: ListTodosInput, output: ListTodosOutput }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure ListTodosInput { @httpQuery(\"gameId\") gameId: String, @httpQuery(\"nextToken\") nextToken: String, @httpQuery(\"maxResults\") maxResults: Integer }\n" +
            "structure ListTodosOutput { items: TodoList, nextToken: String }\n" +
            "list TodoList { member: TodoData }\n" +
            "structure TodoData { @required id: String, gameId: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        assertFalse(out.contains("const filter: Record"), out);
        assertTrue(out.contains("limit: Math.min(input.maxResults ?? 25, 100) }"), out);
    }

    // ── Opt-in strict enforcement (enforceResourceScoping) ─────────────────────

    /** An authenticated (@requiresAuth read) single-op Todo; the @persisted trait is injected. */
    private static String authenticatedTodo(String persistedTrait) {
        return "use com.smithyhono#requiresAuth\n" +
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            persistedTrait + "\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@requiresAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
    }

    /** Emits with enforceResourceScoping = true, returning the written file name (or empty). */
    private Optional<String> emitEnforced(String body) throws Exception {
        Model model = assemble(body);
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));
        ResourceShape todo = model.expectShape(ShapeId.from("com.test#Todo"), ResourceShape.class);
        Path tmp = Files.createTempDirectory("crud-enforce");
        FileManifest manifest = FileManifest.create(tmp);
        CrudEmitter emitter = new CrudEmitter(model, index, "@smithy-hono/security-core", 100, 25, true);
        return emitter.emit(todo, "Todo", "todo", manifest);
    }

    @Test
    void enforcementThrowsForUnscopedAuthenticatedResource() {
        software.amazon.smithy.codegen.core.CodegenException ex = assertThrows(
            software.amazon.smithy.codegen.core.CodegenException.class,
            () -> emitEnforced(authenticatedTodo("@persisted")));
        assertTrue(ex.getMessage().contains("enforceResourceScoping")
                && ex.getMessage().contains("Todo"),
            "enforcement failure should name the setting and resource: " + ex.getMessage());
    }

    @Test
    void enforcementSucceedsForScopedResource() throws Exception {
        Optional<String> file = emitEnforced(authenticatedTodo("@persisted(ownerField: \"ownerId\")"));
        assertEquals(Optional.of("todo.crud.gen.ts"), file,
            "a scoped resource must emit even with enforcement ON");
    }

    @Test
    void enforcementSucceedsForAllowUnscopedResource() throws Exception {
        Optional<String> file = emitEnforced(authenticatedTodo("@persisted(allowUnscoped: true)"));
        assertEquals(Optional.of("todo.crud.gen.ts"), file,
            "allowUnscoped: true must opt out of enforcement");
    }

    @Test
    void emitsOnlyDeclaredLifecycleSubset() throws Exception {
        // read-only resource → factory has GetTodo, no Create/Update/Delete/List.
        String body = "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
        String out = emit(body).content();
        assertTrue(out.contains("async GetTodo(input, c) {"), out);
        assertFalse(out.contains("CreateTodo"), out);
        assertFalse(out.contains("store.list"), out);
    }
}
