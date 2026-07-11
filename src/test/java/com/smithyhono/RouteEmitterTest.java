package com.smithyhono;

import com.smithyhono.traits.RequiresAuthTrait;
import com.smithyhono.writers.RouteEmitter;
import com.smithyhono.writers.TypeScriptFileWriter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.HttpTrait;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class RouteEmitterTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    // ── Operations interface ────────────────────────────────────────────────────

    @Test
    void operationsInterfaceHasExportedInterface() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [GetFoo]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/foo/{id}\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation GetFoo {\n" +
                "  input: GetFooInput\n" +
                "  output: GetFooOutput\n" +
                "}\n" +
                "structure GetFooInput { @httpLabel @required id: String }\n" +
                "structure GetFooOutput { @required name: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitOperationsInterface("TestOperations", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("export interface TestOperations {"), "Interface declaration: " + out);
        assertTrue(out.contains("GetFoo("), "Method GetFoo: " + out);
        assertTrue(out.contains("Promise<"), "Async return type: " + out);
        // D6 — every op threads the optional Hono Context typed with SecurityEnv so
        // handlers can read the pipeline-resolved principal; `c?` keeps existing
        // hand-written impls (which ignore it) type-compatible.
        assertTrue(out.contains(", c?: Context<SecurityEnv>): Promise<"),
                "D6 context arg on interface methods: " + out);
    }

    @Test
    void operationsInterfaceMethodsHaveCorrectInputOutputTypes() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [CreateThing]\n" +
                "}\n" +
                "@http(method: \"POST\", uri: \"/things\", code: 201)\n" +
                "@optionalAuth\n" +
                "operation CreateThing {\n" +
                "  input: CreateThingInput\n" +
                "  output: CreateThingOutput\n" +
                "}\n" +
                "structure CreateThingInput { @required name: String }\n" +
                "structure CreateThingOutput { @required id: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitOperationsInterface("ThingOperations", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("Promise<CreateThingOutput>"), "Output type: " + out);
    }

    @Test
    void operationWithNoOutputReturnsPromiseVoid() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [DeleteThing]\n" +
                "}\n" +
                "@http(method: \"DELETE\", uri: \"/things/{id}\", code: 204)\n" +
                "@optionalAuth\n" +
                "operation DeleteThing {\n" +
                "  input: DeleteThingInput\n" +
                "}\n" +
                "structure DeleteThingInput { @httpLabel @required id: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitOperationsInterface("ThingOperations", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("Promise<void>"), "void return for no output: " + out);
    }

    // ── hasAuthenticatedOps ─────────────────────────────────────────────────────

    @Test
    void hasAuthenticatedOpsTrueWhenRequiresAuthPresent() {
        Model m = Model.assembler().assemble().unwrap();
        OperationShape authedOp = OperationShape.builder()
                .id("test#SecureOp")
                .addTrait(RequiresAuthTrait.builder().permission("read").build())
                .addTrait(HttpTrait.builder()
                        .method("GET")
                        .uri(software.amazon.smithy.model.pattern.UriPattern.parse("/secure"))
                        .code(200)
                        .build())
                .build();
        RouteEmitter emitter = new RouteEmitter(m, null);
        assertTrue(emitter.hasAuthenticatedOps(List.of(authedOp)));
    }

    @Test
    void hasAuthenticatedOpsFalseWhenNoRequiresAuth() {
        Model m = Model.assembler().assemble().unwrap();
        OperationShape publicOp = OperationShape.builder()
                .id("test#PublicOp")
                .addTrait(HttpTrait.builder()
                        .method("GET")
                        .uri(software.amazon.smithy.model.pattern.UriPattern.parse("/public"))
                        .code(200)
                        .build())
                .build();
        RouteEmitter emitter = new RouteEmitter(m, null);
        assertFalse(emitter.hasAuthenticatedOps(List.of(publicOp)));
    }

    @Test
    void hasAuthenticatedOpsFalseForEmptyList() {
        Model m = Model.assembler().assemble().unwrap();
        RouteEmitter emitter = new RouteEmitter(m, null);
        assertFalse(emitter.hasAuthenticatedOps(List.of()));
    }

    // ── Router factory ──────────────────────────────────────────────────────────

    @Test
    void routerFactoryExportsFunction() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [Ping]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/ping\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation Ping {\n" +
                "  output: PingOutput\n" +
                "}\n" +
                "structure PingOutput { @required status: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("export function createTestRouter(ops: TestOperations, middleware?: TestMiddleware): Hono {"),
                "Router factory signature: " + out);
        assertTrue(out.contains("const app = new Hono()"), "Hono instance: " + out);
        assertTrue(out.contains("return app"), "Returns app: " + out);
    }

    // ── Middleware interface ────────────────────────────────────────────────────

    @Test
    void middlewareInterfaceHasAllAndPerOperationFields() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [GetX, UpdateX, DeleteX]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/x/{id}\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation GetX { input: GetXInput output: GetXOutput }\n" +
                "structure GetXInput { @httpLabel @required id: String }\n" +
                "structure GetXOutput { @required name: String }\n" +
                "@http(method: \"PUT\", uri: \"/x/{id}\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation UpdateX { input: UpdateXInput output: GetXOutput }\n" +
                "structure UpdateXInput { @httpLabel @required id: String }\n" +
                "@http(method: \"DELETE\", uri: \"/x/{id}\", code: 204)\n" +
                "@optionalAuth\n" +
                "operation DeleteX { input: GetXInput }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitMiddlewareInterface("TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("export interface TestMiddleware {"), "Interface declaration: " + out);
        assertTrue(out.contains("all?: MiddlewareHandler[]"), "all field: " + out);
        assertTrue(out.contains("GetX?: MiddlewareHandler[]"), "GetX field: " + out);
        assertTrue(out.contains("UpdateX?: MiddlewareHandler[]"), "UpdateX field: " + out);
        assertTrue(out.contains("DeleteX?: MiddlewareHandler[]"), "DeleteX field: " + out);
    }

    @Test
    void middlewareUsesChainWithAuth() {
        Model m = Model.assembler()
                .addUnparsedModel("test.smithy", NS +
                        "service TestService {\n" +
                        "  version: \"1.0\"\n" +
                        "  operations: [GetFoo]\n" +
                        "}\n" +
                        "apply GetFoo @com.smithyhono#requiresAuth(permission: \"foo.read\")\n" +
                        "@http(method: \"GET\", uri: \"/foo/{id}\", code: 200)\n" +
                        "operation GetFoo {\n" +
                        "  input: GetFooInput\n" +
                        "  output: GetFooOutput\n" +
                        "}\n" +
                        "structure GetFooInput { @httpLabel @required id: String }\n" +
                        "structure GetFooOutput { @required name: String }")
                .addImport(getClass().getResource("/traits.smithy"))
                .assemble()
                .unwrap();
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        // Middleware is folded into a single _chain() call so it fits Hono's tuple overloads.
        assertTrue(out.contains("function _chain("), "_chain helper present: " + out);
        assertTrue(out.contains("_chain([...(middleware?.all ?? []), ...(middleware?.GetFoo ?? [])])"),
            "_chain call present: " + out);
        // The legacy Phase-7 authMiddleware seam is retired — route auth is now ONLY the
        // op-tier authorize(OPERATIONS.x) hook fed by the runtime pipeline's principal.
        assertFalse(out.contains("authMiddleware("), "authMiddleware must NOT be emitted: " + out);
        int chainPos = out.indexOf("_chain([");
        int validatorPos = out.indexOf("zValidator(");
        int authorizePos = out.indexOf("authorize(OPERATIONS.GetFoo)");
        int handlerPos = out.indexOf("async (c) => {");
        assertTrue(chainPos < validatorPos, "_chain before validator: " + out);
        assertTrue(validatorPos < authorizePos, "validator before authorize: " + out);
        assertTrue(authorizePos < handlerPos, "authorize immediately before handler: " + out);
    }

    // ── authorize() op-tier hook (Phase S2) ─────────────────────────────────────

    @Test
    void authorizeHookEmittedForRequiresAuthOp() {
        Model m = Model.assembler()
                .addUnparsedModel("test.smithy", NS +
                        "service TestService {\n" +
                        "  version: \"1.0\"\n" +
                        "  operations: [GetFoo]\n" +
                        "}\n" +
                        "apply GetFoo @com.smithyhono#requiresAuth(permission: \"foo.read\")\n" +
                        "@http(method: \"GET\", uri: \"/foo/{id}\", code: 200)\n" +
                        "operation GetFoo {\n" +
                        "  input: GetFooInput\n" +
                        "  output: GetFooOutput\n" +
                        "}\n" +
                        "structure GetFooInput { @httpLabel @required id: String }\n" +
                        "structure GetFooOutput { @required name: String }")
                .addImport(getClass().getResource("/traits.smithy"))
                .assemble()
                .unwrap();
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        // The authorize hook lands after the last validator + the app-middleware spread
        // and immediately before the handler (Phase S2 op-tier authZ).
        assertTrue(out.contains("authorize(OPERATIONS.GetFoo)"), "authorize call present: " + out);
        int validatorPos = out.lastIndexOf("zValidator(");
        int chainPos = out.indexOf("_chain([");
        int authorizePos = out.indexOf("authorize(OPERATIONS.GetFoo)");
        int handlerPos = out.indexOf("async (c) => {");
        assertTrue(chainPos < authorizePos, "app-middleware spread before authorize: " + out);
        assertTrue(validatorPos < authorizePos, "validators before authorize: " + out);
        assertTrue(authorizePos < handlerPos, "authorize immediately before handler: " + out);
    }

    @Test
    void authorizeHookOmittedForAnonymousOp() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [ListFoo]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/foo\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation ListFoo {\n" +
                "  output: ListFooOutput\n" +
                "}\n" +
                "structure ListFooOutput { @required count: Integer }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertFalse(out.contains("authorize(OPERATIONS"), "no authorize hook for anonymous op: " + out);
    }

    @Test
    void middlewareUsesChainWithoutAuth() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [ListFoo]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/foo\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation ListFoo {\n" +
                "  output: ListFooOutput\n" +
                "}\n" +
                "structure ListFooOutput { @required count: Integer }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("_chain([...(middleware?.all ?? []), ...(middleware?.ListFoo ?? [])])"),
            "_chain call present: " + out);
    }


    @Test
    void routerFactoryRegistersHttpRoute() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [GetItem]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/items/{id}\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation GetItem {\n" +
                "  input: GetItemInput\n" +
                "  output: GetItemOutput\n" +
                "}\n" +
                "structure GetItemInput { @httpLabel @required id: String }\n" +
                "structure GetItemOutput { @required name: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("app.get('/items/:id'"), "GET route: " + out);
    }

    @Test
    void listHttpQueryElementsAreCoerced() {
        // A list bound to @httpQuery delivers string elements on the wire; the query
        // validator must coerce each element (else valid numeric input fails closed 400).
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [ListItems]\n" +
                "}\n" +
                "@http(method: \"GET\", uri: \"/items\", code: 200)\n" +
                "@optionalAuth\n" +
                "operation ListItems {\n" +
                "  input: ListItemsInput\n" +
                "  output: ListItemsOutput\n" +
                "}\n" +
                "list IntegerList { member: Integer }\n" +
                "structure ListItemsInput { @httpQuery(\"ids\") ids: IntegerList }\n" +
                "structure ListItemsOutput { @required count: Integer }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        assertTrue(out.contains("z.array(z.string().regex(/^-?\\d+$/).transform(Number).pipe(z.number().int()))"),
                "list @httpQuery elements must be coerced: " + out);
    }

    // ── Validation error shape (VAL-08) ─────────────────────────────────────────

    @Test
    void validatorOnErrorReturnsFieldPathsNotRawValues() {
        Model m = modelFor(
                "service TestService {\n" +
                "  version: \"1.0\"\n" +
                "  operations: [CreateItem]\n" +
                "}\n" +
                "@http(method: \"POST\", uri: \"/items\", code: 201)\n" +
                "@optionalAuth\n" +
                "operation CreateItem {\n" +
                "  input: CreateItemInput\n" +
                "  output: CreateItemOutput\n" +
                "}\n" +
                "structure CreateItemInput { @required name: String }\n" +
                "structure CreateItemOutput { @required id: String }");
        ModelIndex index = new ModelIndex(m, ShapeId.from("test#TestService"));
        RouteEmitter emitter = new RouteEmitter(m, index);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitRouterFactory("createTestRouter", "TestOperations", "TestMiddleware", index.getOperations(), writer);
        String out = writer.getContent();
        // VAL-08 — onError maps issues to { path, code } only, never echoing raw values.
        assertTrue(out.contains("fieldErrors: result.error.issues.map(i => ({ path: i.path.join('.'), code: i.code }))"),
            "onError uses field-path-only shape: " + out);
        assertFalse(out.contains("result.error.message"),
            "onError must not echo result.error.message (VAL-08): " + out);
    }
}
