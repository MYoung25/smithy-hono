package com.smithyhono;

import com.smithyhono.traits.LiveTrait;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;

import java.net.URL;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase L1: @live trait parsing (ModelIndex.liveConfig) + LiveResourceValidator rules.
 */
class LiveResourceTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#persisted\n" +
        "use com.smithyhono#live\n";

    private ValidatedResult<Model> assemble(String body) {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", HEADER + body)
                .assemble();
    }

    /** A valid @live @persisted Todo. {@code liveTrait} is spliced above the resource. */
    private static String todo(String liveTrait, String readOutputBody) {
        return todo("@persisted", liveTrait, readOutputBody);
    }

    /** Same, with an explicit {@code persistedTrait} (e.g. to add ownerField scoping). */
    private static String todo(String persistedTrait, String liveTrait, String readOutputBody) {
        return "service S { version: \"1.0\", resources: [Todo] }\n" +
            persistedTrait + "\n" + liveTrait + "\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "  update: UpdateTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"PUT\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@idempotent\n" +
            "operation UpdateTodo { input: UpdateTodoInput, output: UpdateTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure UpdateTodoInput { @httpLabel @required id: String, title: String }\n" +
            "structure UpdateTodoOutput { item: TodoData }\n" +
            "structure TodoData { " + readOutputBody + " }\n" +
            "@sensitive\nstring SecretString\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
    }

    private static long liveErrors(ValidatedResult<Model> r) {
        return r.getValidationEvents(Severity.ERROR).stream()
            .filter(e -> e.getMessage().contains("Phase L1")).count();
    }

    private static boolean hasWarning(ValidatedResult<Model> r, String id) {
        return r.getValidationEvents(Severity.WARNING).stream().anyMatch(e -> e.getId().equals(id));
    }

    // ── Trait parsing ─────────────────────────────────────────────────────────

    @Test
    void parsesBareLive() {
        ValidatedResult<Model> r = assemble(todo("@live", "@required id: String, title: String"));
        assertEquals(0, liveErrors(r), "bare @live valid. Events: " + r.getValidationEvents(Severity.ERROR));
        ModelIndex index = new ModelIndex(r.unwrap(), ShapeId.from("com.test#S"));
        assertEquals(1, index.liveResources().size());
        ResourceShape todo = index.liveResources().get(0);
        LiveTrait cfg = index.liveConfig(todo);
        assertTrue(cfg.getKeyMember().isEmpty(), "keyMember unset on bare form");
        assertTrue(cfg.getEventType().isEmpty(), "eventType unset on bare form");
        assertFalse(cfg.isLifecycleEvents());
        assertFalse(cfg.isPushRecords());
    }

    @Test
    void parsesRichLive() {
        ValidatedResult<Model> r = assemble(todo(
            "@live(keyMember: \"id\", eventType: \"todo:moved\", lifecycleEvents: true)",
            "@required id: String, title: String"));
        assertEquals(0, liveErrors(r), "rich @live valid. Events: " + r.getValidationEvents(Severity.ERROR));
        ModelIndex index = new ModelIndex(r.unwrap(), ShapeId.from("com.test#S"));
        LiveTrait cfg = index.liveConfig(index.liveResources().get(0));
        assertEquals("id", cfg.getKeyMember().orElse(null));
        assertEquals("todo:moved", cfg.getEventType().orElse(null));
        assertTrue(cfg.isLifecycleEvents());
    }

    // ── Validator ─────────────────────────────────────────────────────────────

    @Test
    void keyMemberNotAnIdentifierFailsBuild() {
        ValidatedResult<Model> r = assemble(todo(
            "@live(keyMember: \"title\")", "@required id: String, title: String"));
        assertTrue(r.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("not a resource identifier")),
            "non-identifier keyMember should fail. Events: " + r.getValidationEvents(Severity.ERROR));
    }

    @Test
    void liveRequiresPersistedViaSelector() {
        // Applying @live to a non-@persisted resource is rejected by the trait selector.
        ValidatedResult<Model> r = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@live\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        assertFalse(r.getValidationEvents(Severity.ERROR).isEmpty(),
            "@live without @persisted must fail the build (selector). Events: "
                + r.getValidationEvents(Severity.ERROR));
    }

    @Test
    void pushRecordsWithSensitiveOutputFailsBuild() {
        ValidatedResult<Model> r = assemble(todo(
            "@live(pushRecords: true)",
            "@required id: String, title: SecretString"));
        assertTrue(r.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("pushRecords") && e.getMessage().contains("@sensitive")),
            "pushRecords + @sensitive read output should fail. Events: "
                + r.getValidationEvents(Severity.ERROR));
    }

    @Test
    void pushRecordsWithOwnerScopingFailsBuild() {
        // F2: owner/tenant scoping is a per-recipient projection signal — pushRecords must ERROR
        // even without any @sensitive member (each owner's row must not be broadcast to all).
        ValidatedResult<Model> r = assemble(todo(
            "@persisted(ownerField: \"ownerId\")", "@live(pushRecords: true)",
            "@required id: String, title: String"));
        assertTrue(r.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("pushRecords")
                    && e.getMessage().contains("owner/tenant-scoped")),
            "pushRecords + owner scoping should fail. Events: "
                + r.getValidationEvents(Severity.ERROR));
    }

    @Test
    void pushRecordsWithoutRedactionWarns() {
        ValidatedResult<Model> r = assemble(todo(
            "@live(pushRecords: true)", "@required id: String, title: String"));
        assertEquals(0, liveErrors(r),
            "pushRecords on a non-redacted output should not error. Events: "
                + r.getValidationEvents(Severity.ERROR));
        assertTrue(hasWarning(r, "LiveResource.PushRecordsMayLeak"),
            "pushRecords should emit an advisory WARNING. Events: "
                + r.getValidationEvents(Severity.WARNING));
    }

    @Test
    void collidingModeledRouteFailsBuild() {
        // F3: a modeled op already binding GET /todo/:id/events collides with the synthetic live
        // subscribe route — the generated router would shadow it, so it's a build ERROR.
        ValidatedResult<Model> r = assemble(
            "service S { version: \"1.0\", resources: [Todo], operations: [WatchTodo] }\n" +
            "@persisted\n@live\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "@http(method: \"GET\", uri: \"/todo/{id}/events\", code: 200)\n@readonly\n" +
            "operation WatchTodo { input: GetTodoInput, output: GetTodoOutput }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        assertTrue(r.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("colliding route")
                    && e.getMessage().contains("WatchTodo")),
            "colliding modeled route should fail. Events: " + r.getValidationEvents(Severity.ERROR));
    }

    @Test
    void nonLiveResourceIsUnaffected() {
        // Same shape, no @live -> no live resources, no live events.
        ValidatedResult<Model> r = assemble(todo("", "@required id: String, title: SecretString"));
        assertEquals(0, liveErrors(r),
            "non-@live resource must be unaffected. Events: " + r.getValidationEvents(Severity.ERROR));
        ModelIndex index = new ModelIndex(r.unwrap(), ShapeId.from("com.test#S"));
        assertTrue(index.liveResources().isEmpty(), "no @live resources");
    }
}
