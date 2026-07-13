package com.smithyhono;

import com.smithyhono.writers.LiveEmitter;
import com.smithyhono.writers.MetadataRegistryEmitter;
import com.smithyhono.writers.RouteEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ShapeId;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase L1/L2: golden-string assertions for {@link LiveEmitter}'s generated realtime router,
 * plus the {@link MetadataRegistryEmitter} synthetic route class and the no-churn regression.
 */
class LiveEmitterTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#persisted\n" +
        "use com.smithyhono#live\n" +
        "use com.smithyhono#requiresAuth\n";

    /** A @live @persisted Todo. {@code readAuth} is the auth trait spliced onto the read op. */
    private static String todo(String liveTrait, String readAuth) {
        return todo("@persisted", liveTrait, readAuth);
    }

    /** Same, with an explicit {@code persistedTrait} (e.g. to add ownerField scoping). */
    private static String todo(String persistedTrait, String liveTrait, String readAuth) {
        return "service S { version: \"1.0\", resources: [Todo] }\n" +
            persistedTrait + "\n" + liveTrait + "\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "  update: UpdateTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n" + readAuth + "\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation UpdateTodo { input: UpdateTodoInput, output: UpdateTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure UpdateTodoInput { @httpLabel @required id: String, title: String }\n" +
            "structure UpdateTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String, title: String }\n" +
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

    private String emitLive(String body) throws Exception {
        Model model = assemble(body);
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));
        RouteEmitter routeEmitter = new RouteEmitter(model, index);
        LiveEmitter emitter = new LiveEmitter(model, index, routeEmitter, "@smithy-hono/security-core");
        ResourceShape todo = model.expectShape(ShapeId.from("com.test#Todo"), ResourceShape.class);
        Path tmp = Files.createTempDirectory("live-test");
        FileManifest manifest = FileManifest.create(tmp);
        Optional<String> fileName = emitter.emit(todo, "Todo", "todo", manifest);
        assertEquals(Optional.of("todo.live.gen.ts"), fileName);
        return Files.readString(tmp.resolve(fileName.get()));
    }

    // ── Router shape ───────────────────────────────────────────────────────────

    @Test
    void emitsFunctionalRouterWithPinnedConventions() throws Exception {
        String out = emitLive(todo("@live", "@optionalAuth"));

        // Router factory matches the frozen contract signature: takes (hub, store) for a stable
        // API (the store carries the resource-tier entitlement guard when scoped).
        assertTrue(out.contains("export function createTodoLiveRouter(hub: RealtimeHub, store: DataStore<TodoData>): Hono<SecurityEnv> {"), out);
        // Route path = /<lowercasedResource>/:<keyMember>/events (PINNED).
        assertTrue(out.contains("app.get('/todo/:id/events'"), out);
        // channelId = `${lowercasedResource}:${id}` (PINNED).
        assertTrue(out.contains("const channelId = `todo:${id}`"), out);
        // Bridges to the frozen liveEventStream helper with the event-types constant.
        assertTrue(out.contains("return liveEventStream(c, hub, channelId, TODO_LIVE_EVENT_TYPES)"), out);
        // Event-types constant defaults to "<resource>:updated".
        assertTrue(out.contains("export const TODO_LIVE_EVENT_TYPES = [\"todo:updated\"] as const"), out);

        // Imports from the FROZEN @smithy-hono/realtime contract.
        assertTrue(out.contains("import type { RealtimeHub } from '@smithy-hono/realtime'"), out);
        assertTrue(out.contains("import { liveEventStream } from '@smithy-hono/realtime'"), out);
        assertTrue(out.contains("import type { SecurityEnv } from '@smithy-hono/security-core'"), out);

        // Composition wiring is a README comment (withLiveNotify decorator + mount). The router
        // gets the RAW store (entitlement guard on the un-decorated read path); the ops factory
        // gets the notify-decorated liveStore.
        assertTrue(out.contains("const liveStore = withLiveNotify(store, hub, { resource: 'todo', eventType: 'todo:updated' })"), out);
        assertTrue(out.contains("app.route('/', createTodoLiveRouter(hub, store))"), out);

        // Unscoped @persisted (no ownerField/tenantField) -> NO entitlement guard, but a DANGER
        // note in the router JSDoc, and no scopeFrom/DataScope/NotFound plumbing.
        assertFalse(out.contains("scopeFrom(c)"), out);
        assertFalse(out.contains("await store.get("), out);
        assertTrue(out.contains("NO owner/tenant isolation"), out);
    }

    @Test
    void scopedResourceEmitsEntitlementGuard() throws Exception {
        String out = emitLive(todo("@persisted(ownerField: \"ownerId\")", "@live",
            "@requiresAuth(permission: \"todos.read\")"));

        // Router takes the scoped store and mirrors the read op's resource-tier scope: resolve the
        // channel key, store.get(id, scopeFrom(c)), 404 on null BEFORE liveEventStream.
        assertTrue(out.contains("export function createTodoLiveRouter(hub: RealtimeHub, store: DataStore<TodoData>): Hono<SecurityEnv> {"), out);
        assertTrue(out.contains("const existing = await store.get(id, scopeFrom(c))"), out);
        assertTrue(out.contains("if (!existing) throw new TodoNotFound(`not found: ${id}`)"), out);
        // scopeFrom helper is emitted, gated on the declared ownerField, fail-closed on no principal.
        assertTrue(out.contains("function scopeFrom(c?: Context<SecurityEnv>): DataScope {"), out);
        assertTrue(out.contains("return { ownerId: p.id }"), out);
        assertTrue(out.contains("if (!p) throw new Error('scopeFrom: missing authenticated principal"), out);
        // Imports: DataStore + DataScope from data-core, Context from hono, NotFound from the group file.
        assertTrue(out.contains("import type { DataStore, DataScope } from '@smithy-hono/data-core'"), out);
        assertTrue(out.contains("import type { Context } from 'hono'"), out);
        assertTrue(out.contains("import { TodoNotFound } from './todo.gen'"), out);
        // The guard runs BEFORE the channel is opened.
        assertTrue(out.indexOf("await store.get(id, scopeFrom(c))")
            < out.indexOf("const channelId = `todo:${id}`"), "guard must precede subscribe:\n" + out);
    }

    @Test
    void ungatedWhenReadIsAnonymous() throws Exception {
        String out = emitLive(todo("@live", "@optionalAuth"));
        // Read op is @optionalAuth -> no authorize gate, no OPERATIONS import (matches read).
        assertFalse(out.contains("authorize(OPERATIONS."), out);
        assertFalse(out.contains("import { authorize }"), out);
        assertFalse(out.contains("import { OPERATIONS }"), out);
    }

    @Test
    void authGatedWhenReadRequiresAuth() throws Exception {
        String out = emitLive(todo("@live", "@requiresAuth(permission: \"todos.read\")"));
        // Phase L2: subscribe reuses the read op's op-tier authorize().
        assertTrue(out.contains("authorize(OPERATIONS.GetTodo)"), out);
        assertTrue(out.contains("import { authorize } from '@smithy-hono/security-core'"), out);
        assertTrue(out.contains("import { OPERATIONS } from './registry.gen'"), out);
    }

    @Test
    void lifecycleEventsAddCreatedAndDeleted() throws Exception {
        String out = emitLive(todo("@live(lifecycleEvents: true)", "@optionalAuth"));
        assertTrue(out.contains(
            "TODO_LIVE_EVENT_TYPES = [\"todo:updated\", \"todo:created\", \"todo:deleted\"] as const"), out);
    }

    @Test
    void eventTypeOverrideFlowsToConstAndWiring() throws Exception {
        String out = emitLive(todo("@live(eventType: \"todo:moved\")", "@optionalAuth"));
        assertTrue(out.contains("TODO_LIVE_EVENT_TYPES = [\"todo:moved\"] as const"), out);
        assertTrue(out.contains("eventType: 'todo:moved'"), out);
    }

    // ── Registry route class + no-churn regression ─────────────────────────────

    @Test
    void registryGainsSyntheticLiveRouteWhenLivePresent() throws Exception {
        Model model = assemble(todo("@live", "@requiresAuth(permission: \"todos.read\")"));
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));
        Path tmp = Files.createTempDirectory("live-reg-test");
        FileManifest manifest = FileManifest.create(tmp);
        new MetadataRegistryEmitter(index).emit(index.getOperations(), manifest);
        String reg = Files.readString(tmp.resolve("registry.gen.ts"));

        assertTrue(reg.contains("live?: boolean"), "interface gains live? when @live present:\n" + reg);
        assertTrue(reg.contains("TodoLiveSubscribe: {"), reg);
        assertTrue(reg.contains("live: true,"), reg);
        assertTrue(reg.contains("streaming: true,"), reg);
        assertTrue(reg.contains("path: '/todo/:id/events',"), reg);
        // Auth schemes mirror the read op (oidc from @requiresAuth) + its permission.
        assertTrue(reg.contains("authSchemes: [{ type: 'oidc' }],"), reg);
        assertTrue(reg.contains("requiredPermissions: [\"todos.read\"],"), reg);
        assertTrue(reg.contains("'GET /todo/:id/events': OPERATIONS.TodoLiveSubscribe,"), reg);
    }

    @Test
    void registryDoesNotChurnWithoutLive() throws Exception {
        // Same Todo shape but no @live: registry must gain NO live? field and NO synthetic entry.
        Model model = assemble(todo("", "@requiresAuth(permission: \"todos.read\")"));
        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));
        assertTrue(index.liveResources().isEmpty(), "no @live resources");
        Path tmp = Files.createTempDirectory("live-nochurn-test");
        FileManifest manifest = FileManifest.create(tmp);
        new MetadataRegistryEmitter(index).emit(index.getOperations(), manifest);
        String reg = Files.readString(tmp.resolve("registry.gen.ts"));

        assertFalse(reg.contains("live?: boolean"), "no live? field without @live:\n" + reg);
        assertFalse(reg.contains("LiveSubscribe"), "no synthetic live op without @live:\n" + reg);
        assertFalse(reg.contains("live: true"), "no live route class without @live:\n" + reg);
    }
}
