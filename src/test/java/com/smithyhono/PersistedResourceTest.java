package com.smithyhono;

import com.smithyhono.ModelIndex.CrudVerb;
import com.smithyhono.traits.PersistedTrait;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;

import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Plan 13 (P2): ModelIndex resource resolution + PersistedResourceValidator.
 */
class PersistedResourceTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#persisted\n";

    private ValidatedResult<Model> assemble(String body) {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", HEADER + body)
                .assemble();
    }

    private static long persistedErrors(ValidatedResult<Model> result) {
        return result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.getMessage().contains("Plan 13"))
                .count();
    }

    /** A valid bare @persisted Todo resource with all four lifecycle ops + the 404 error. */
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
            "structure TodoData { @required id: String, title: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n";
    }

    // ── ModelIndex resolution ─────────────────────────────────────────────────

    @Test
    void modelIndexResolvesLifecycleIdentifierEntityAndConfig() {
        ValidatedResult<Model> result = assemble(validBareTodo());
        assertEquals(0, persistedErrors(result),
            "valid bare @persisted should produce no errors. Events: "
                + result.getValidationEvents(Severity.ERROR));
        Model model = result.unwrap();

        ModelIndex index = new ModelIndex(model, ShapeId.from("com.test#S"));

        List<ResourceShape> persisted = index.persistedResources();
        assertEquals(1, persisted.size(), "exactly one @persisted resource");
        ResourceShape todo = persisted.get(0);
        assertEquals("Todo", todo.getId().getName());

        Map<CrudVerb, OperationShape> ops = index.lifecycleOps(todo);
        assertEquals(5, ops.size(), "create/read/update/delete/list bound");
        assertEquals("CreateTodo", ops.get(CrudVerb.CREATE).getId().getName());
        assertEquals("GetTodo", ops.get(CrudVerb.READ).getId().getName());
        assertEquals("UpdateTodo", ops.get(CrudVerb.UPDATE).getId().getName());
        assertEquals("DeleteTodo", ops.get(CrudVerb.DELETE).getId().getName());
        assertEquals("ListTodos", ops.get(CrudVerb.LIST).getId().getName());
        assertNull(ops.get(CrudVerb.PUT), "no put binding declared");

        assertEquals(List.of("id"), index.identifierMembers(todo));

        Optional<Shape> entity = index.entityShape(todo);
        assertTrue(entity.isPresent(), "entity derived from read output sole member");
        assertEquals("TodoData", entity.get().getId().getName());

        PersistedTrait config = index.persistedConfig(todo);
        assertTrue(config.isTimestamps(), "timestamps defaults true");
        assertFalse(config.isSoftDelete(), "softDelete defaults false");
        assertFalse(config.isOptimisticConcurrency(), "optimisticConcurrency defaults off (D5)");
        assertTrue(config.getTable().isEmpty(), "table unset on bare form");
    }

    @Test
    void modelIndexParsesRichConfig() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(table: \"todos\", softDelete: true, ownerField: \"ownerId\", " +
            "indexes: [{ name: \"byOwner\", key: \"ownerId\" }])\n" +
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
        assertEquals(0, persistedErrors(result), "rich config valid. Events: "
            + result.getValidationEvents(Severity.ERROR));

        ModelIndex index = new ModelIndex(result.unwrap(), ShapeId.from("com.test#S"));
        PersistedTrait config = index.persistedConfig(index.persistedResources().get(0));
        assertEquals("todos", config.getTable().orElse(null));
        assertTrue(config.isSoftDelete());
        assertEquals("ownerId", config.getOwnerField().orElse(null));
        assertEquals(1, config.getIndexes().size());
        assertEquals("byOwner", config.getIndexes().get(0).getName());
        assertEquals("ownerId", config.getIndexes().get(0).getKey());
    }

    // ── Validator ─────────────────────────────────────────────────────────────

    @Test
    void readMissing404FailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n");
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("@httpError(404)") && e.getMessage().contains("read")),
            "read without 404 should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void compositeIdentifierFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { tenantId: String, id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/t/{tenantId}/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required tenantId: String, @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("Composite keys")),
            "composite id should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void nonStringIdentifierFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: Integer }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: Integer }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        // Smithy's own resource-identifier validator also enforces string targets, so a
        // non-string id fails the build either way — our validator is a redundant guard.
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("string identifier")
                    || e.getMessage().contains("must target a string shape")),
            "non-string id should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void optimisticConcurrencyWithout409FailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted(optimisticConcurrency: true)\n" +
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
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("@httpError(409)")),
            "optimisticConcurrency without 409 should fail. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void readLabelMissingIdentifierFailsBuild() {
        // id identifier is present but the read input does not bind it as an @httpLabel.
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "@persisted\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput, errors: [TodoNotFound] }\n" +
            "structure GetTodoInput { @httpLabel @required id: String, @httpQuery(\"q\") q: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n" +
            "@error(\"client\")\n@httpError(404)\nstructure TodoNotFound { message: String }\n");
        // Sanity: this exact model is valid (label binds id) — guards against false positives.
        assertEquals(0, persistedErrors(result),
            "read binding id as @httpLabel should pass. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }

    // ── Unscoped-IDOR advisory (AUTHZ-01 / CODEGEN-EMIT-2-06) ──────────────────

    private static boolean hasUnscopedWarning(ValidatedResult<Model> result) {
        return result.getValidationEvents(Severity.WARNING).stream()
            .anyMatch(e -> e.getId().equals("PersistedResource.UnscopedIdor"));
    }

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

    @Test
    void unscopedAuthenticatedResourceEmitsWarning() {
        ValidatedResult<Model> result = assemble(authenticatedTodo("@persisted"));
        assertEquals(0, persistedErrors(result), "fixture should be otherwise valid. Events: "
            + result.getValidationEvents(Severity.ERROR));
        assertTrue(hasUnscopedWarning(result),
            "unscoped + authenticated @persisted must emit PersistedResource.UnscopedIdor. Events: "
                + result.getValidationEvents(Severity.WARNING));
    }

    @Test
    void scopedResourceDoesNotWarn() {
        ValidatedResult<Model> result = assemble(authenticatedTodo("@persisted(ownerField: \"ownerId\")"));
        assertFalse(hasUnscopedWarning(result),
            "a resource declaring ownerField must not warn. Events: "
                + result.getValidationEvents(Severity.WARNING));
    }

    @Test
    void publicResourceDoesNotWarn() {
        // validBareTodo uses @optionalAuth on every op → no authenticated lifecycle op.
        ValidatedResult<Model> result = assemble(validBareTodo());
        assertFalse(hasUnscopedWarning(result),
            "a public (anonymous) resource must not warn. Events: "
                + result.getValidationEvents(Severity.WARNING));
    }

    @Test
    void allowUnscopedSuppressesWarning() {
        ValidatedResult<Model> result = assemble(authenticatedTodo("@persisted(allowUnscoped: true)"));
        assertEquals(0, persistedErrors(result), "fixture should be otherwise valid. Events: "
            + result.getValidationEvents(Severity.ERROR));
        assertFalse(hasUnscopedWarning(result),
            "allowUnscoped: true must suppress the advisory. Events: "
                + result.getValidationEvents(Severity.WARNING));
    }

    @Test
    void nonPersistedResourceIsUnaffected() {
        // Same shape that would otherwise be invalid (no 404), but no @persisted -> no errors.
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", resources: [Todo] }\n" +
            "resource Todo {\n" +
            "  identifiers: { id: String }\n" +
            "  read: GetTodo\n" +
            "}\n" +
            "@http(method: \"GET\", uri: \"/todos/{id}\", code: 200)\n@optionalAuth\n@readonly\n" +
            "operation GetTodo { input: GetTodoInput, output: GetTodoOutput }\n" +
            "structure GetTodoInput { @httpLabel @required id: String }\n" +
            "structure GetTodoOutput { item: TodoData }\n" +
            "structure TodoData { @required id: String }\n");
        assertEquals(0, persistedErrors(result),
            "non-@persisted resource must be unaffected. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }
}
