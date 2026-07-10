package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/** End-to-end smoke: HonoCodegenPlugin wires CrudEmitter + registry + peer dep. */
class PluginPersistedSmokeTest {

    private static final String MODEL =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#persisted\n" +
        "service S { version: \"1.0\", resources: [Todo] }\n" +
        "@persisted\n" +
        "resource Todo {\n" +
        "  identifiers: { id: String }\n" +
        "  create: CreateTodo\n  read: GetTodo\n  update: UpdateTodo\n  delete: DeleteTodo\n  list: ListTodos\n" +
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

    @Test
    void emitsCrudFileRegistryFieldsAndPeerDep() throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl);
        Model model = Model.assembler().addImport(traitsUrl)
            .addUnparsedModel("test.smithy", MODEL).assemble().unwrap();

        Path out = Files.createTempDirectory("plugin-persisted-smoke");
        PluginContext ctx = PluginContext.builder()
            .model(model)
            .fileManifest(FileManifest.create(out))
            .settings(Node.objectNodeBuilder().withMember("service", "com.test#S").build())
            .build();
        new HonoCodegenPlugin().execute(ctx);

        // crud file emitted alongside todo.gen.ts.
        Path crud = out.resolve("todo.crud.gen.ts");
        assertTrue(Files.exists(crud), "todo.crud.gen.ts should be emitted");
        String crudContent = Files.readString(crud);
        assertTrue(crudContent.contains("createDefaultTodoOperations"), crudContent);
        assertTrue(crudContent.contains("from './todo.gen'"), crudContent);

        // index.ts re-exports it.
        assertTrue(Files.readString(out.resolve("index.ts")).contains("export * from './todo.crud.gen'"));

        // registry populates CRUD fields for the lifecycle ops.
        String registry = Files.readString(out.resolve("registry.gen.ts"));
        assertTrue(registry.contains("resource: 'Todo'"), registry);
        assertTrue(registry.contains("crudVerb: 'create'"), registry);
        assertTrue(registry.contains("crudVerb: 'list'"), registry);
        assertTrue(registry.contains("identifierMembers: ['id']"), registry);

        // package.json gains the data-core peer dep.
        String pkg = Files.readString(out.resolve("package.json"));
        assertTrue(pkg.contains("\"@smithy-hono/data-core\": \">=0.1.0\""), pkg);
    }
}
