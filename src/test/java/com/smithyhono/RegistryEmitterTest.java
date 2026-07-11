package com.smithyhono;

import com.smithyhono.writers.MetadataRegistryEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class RegistryEmitterTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#requiresAuth\n" +
        "use com.smithyhono#cost\n" +
        "use com.smithyhono#sigv4Hmac\n" +
        "use com.smithyhono#sseStream\n";

    private static final String MODEL = HEADER +
        "service MixedService {\n" +
        "  version: \"1.0\"\n" +
        "  operations: [ListThings, SearchThings, GetThing, CreateThing, SyncThing, StreamThings]\n" +
        "}\n" +
        "@http(method: \"GET\", uri: \"/things\", code: 200)\n" +
        "@readonly\n" +
        "@optionalAuth\n" +
        "@paginated(inputToken: \"nextToken\", outputToken: \"nextToken\", items: \"items\", pageSize: \"limit\")\n" +
        "operation ListThings { input: ListThingsInput, output: ListThingsOutput }\n" +
        "@http(method: \"GET\", uri: \"/things/search\", code: 200)\n" +
        "@readonly\n" +
        "@optionalAuth\n" +
        "@paginated(inputToken: \"nextToken\", outputToken: \"nextToken\", items: \"items\", pageSize: \"max\")\n" +
        "operation SearchThings { input: SearchThingsInput, output: ListThingsOutput }\n" +
        "@http(method: \"GET\", uri: \"/things/{id}\", code: 200)\n" +
        "@readonly\n" +
        "@requiresAuth(permission: \"things.read\")\n" +
        "operation GetThing { input: GetThingInput, output: GetThingOutput }\n" +
        "@http(method: \"POST\", uri: \"/things\", code: 201)\n" +
        "@cost(value: 7)\n" +
        "@requiresAuth(permission: \"things.write\")\n" +
        "operation CreateThing { input: CreateThingInput, output: GetThingOutput }\n" +
        "@http(method: \"PUT\", uri: \"/things/{id}\", code: 200)\n" +
        "@sigv4Hmac\n" +
        "operation SyncThing { input: GetThingInput, output: GetThingOutput }\n" +
        "@http(method: \"GET\", uri: \"/things/stream\", code: 200)\n" +
        "@readonly\n" +
        "@optionalAuth\n" +
        "@sseStream\n" +
        "operation StreamThings { output: ListThingsOutput }\n" +
        "structure ListThingsInput {\n" +
        "  @httpQuery(\"limit\") limit: Integer\n" +
        "  @httpQuery(\"nextToken\") nextToken: String\n" +
        "}\n" +
        "structure SearchThingsInput {\n" +
        "  @httpQuery(\"q\") q: String\n" +
        "  @httpQuery(\"max\") @range(min: 1, max: 40) max: Integer\n" +
        "  @httpQuery(\"nextToken\") nextToken: String\n" +
        "}\n" +
        "structure ListThingsOutput { @required items: ThingList, nextToken: String }\n" +
        "structure GetThingInput { @httpLabel @required id: String }\n" +
        "structure GetThingOutput { @required thing: Thing }\n" +
        "structure CreateThingInput {\n" +
        "  @required @length(min: 1, max: 50) name: String\n" +
        "}\n" +
        "structure Thing { @required id: String, @required name: String }\n" +
        "list ThingList { member: Thing }\n";

    private String emit() throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", MODEL)
                .assemble()
                .unwrap();
        ModelIndex index = new ModelIndex(model, software.amazon.smithy.model.shapes.ShapeId.from("com.test#MixedService"));

        Path tmp = Files.createTempDirectory("registry-test");
        FileManifest manifest = FileManifest.create(tmp);
        // Non-default fallbacks (200/30) so the fallback path is distinguishable from the
        // conventional 100/25 and from model-derived caps.
        boolean wrote = new MetadataRegistryEmitter(index, 200, 30).emit(index.getOperations(), manifest);
        assertTrue(wrote, "registry should be emitted");
        return Files.readString(tmp.resolve("registry.gen.ts"));
    }

    @Test
    void emitsTypesAndRecords() throws Exception {
        String out = emit();
        assertTrue(out.contains("export interface OperationMeta {"), out);
        assertTrue(out.contains("export type AuthScheme ="), out);
        assertTrue(out.contains("export const OPERATIONS: Record<string, OperationMeta> = {"), out);
        assertTrue(out.contains("export const OPERATION_BY_ROUTE: Record<string, OperationMeta> = {"), out);
    }

    @Test
    void listThings_isReadonlyAnonymousPaginated() throws Exception {
        String out = emit();
        String block = block(out, "ListThings");
        assertTrue(block.contains("method: 'GET'"), block);
        assertTrue(block.contains("path: '/things'"), block);
        assertTrue(block.contains("readonly: true"), block);
        assertTrue(block.contains("authSchemes: [{ type: 'anonymous' }]"), block);
        assertTrue(block.contains("requiredPermissions: []"), block);
        // No @range cap on its page-size member → configured fallback (200/30).
        assertTrue(block.contains("pagination: { maxPageSize: 200, defaultPageSize: 30 }"), block);
        assertTrue(block.contains("cost: 1"), block);
    }

    @Test
    void searchThings_derivesMaxPageSizeFromRangeTrait() throws Exception {
        String out = emit();
        String block = block(out, "SearchThings");
        // @range(max: 40) on the 'max' page-size member → model-derived cap; default
        // falls back (30) but is clamped to never exceed the cap.
        assertTrue(block.contains("pagination: { maxPageSize: 40, defaultPageSize: 30 }"), block);
    }

    @Test
    void getThing_isReadonlyOidcWithPermission() throws Exception {
        String out = emit();
        String block = block(out, "GetThing");
        assertTrue(block.contains("path: '/things/:id'"), block);
        assertTrue(block.contains("readonly: true"), block);
        assertTrue(block.contains("authSchemes: [{ type: 'oidc' }]"), block);
        assertTrue(block.contains("requiredPermissions: [\"things.read\"]"), block);
    }

    @Test
    void createThing_hasCostAndConstrainedInput() throws Exception {
        String out = emit();
        String block = block(out, "CreateThing");
        assertTrue(block.contains("method: 'POST'"), block);
        assertTrue(block.contains("cost: 7"), block);
        assertTrue(block.contains("requiredPermissions: [\"things.write\"]"), block);
        assertTrue(block.contains("constraints: { hasConstrainedInput: true }"), block);
    }

    @Test
    void syncThing_usesSigv4Hmac() throws Exception {
        String out = emit();
        String block = block(out, "SyncThing");
        assertTrue(block.contains("authSchemes: [{ type: 'sigv4Hmac' }]"), block);
    }

    @Test
    void streamThings_emitsStreamingFlag() throws Exception {
        String out = emit();
        String streaming = block(out, "StreamThings");
        assertTrue(streaming.contains("streaming: true"), streaming);
        // A non-streaming op omits the field entirely.
        String getThing = block(out, "GetThing");
        assertFalse(getThing.contains("streaming:"), getThing);
    }

    @Test
    void routeIndexMapsMethodAndPath() throws Exception {
        String out = emit();
        assertTrue(out.contains("'GET /things': OPERATIONS.ListThings,"), out);
        assertTrue(out.contains("'PUT /things/:id': OPERATIONS.SyncThing,"), out);
    }

    /** Extract the OPERATIONS entry block for an operation by name. */
    private static String block(String out, String op) {
        int start = out.indexOf("  " + op + ": {");
        assertTrue(start >= 0, "operation " + op + " not found in:\n" + out);
        int end = out.indexOf("  },", start);
        return out.substring(start, end);
    }
}
