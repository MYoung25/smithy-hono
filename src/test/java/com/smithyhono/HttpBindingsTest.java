package com.smithyhono;

import com.smithyhono.writers.HttpBinding;
import com.smithyhono.writers.InputBindings;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;

import static org.junit.jupiter.api.Assertions.*;

class HttpBindingsTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    private static MemberShape member(Model m, String structName, String memberName) {
        return m.expectShape(ShapeId.from("test#" + structName), StructureShape.class)
                .getMember(memberName)
                .orElseThrow(() -> new AssertionError("Member not found: " + memberName));
    }

    // ── resolveBinding ─────────────────────────────────────────────────────────

    @Test
    void httpLabelResolvesToPath() {
        Model m = modelFor("structure Input { @httpLabel @required id: String }");
        MemberShape mb = member(m, "Input", "id");
        assertEquals(HttpBinding.PATH, InputBindings.resolveBinding(mb, false));
        assertEquals(HttpBinding.PATH, InputBindings.resolveBinding(mb, true));
    }

    @Test
    void httpQueryResolvesToQuery() {
        Model m = modelFor("structure Input { @httpQuery(\"filter\") filter: String }");
        MemberShape mb = member(m, "Input", "filter");
        assertEquals(HttpBinding.QUERY, InputBindings.resolveBinding(mb, false));
        assertEquals(HttpBinding.QUERY, InputBindings.resolveBinding(mb, true));
    }

    @Test
    void httpHeaderResolvesToHeader() {
        Model m = modelFor("structure Input { @httpHeader(\"X-Api-Key\") apiKey: String }");
        MemberShape mb = member(m, "Input", "apiKey");
        assertEquals(HttpBinding.HEADER, InputBindings.resolveBinding(mb, false));
        assertEquals(HttpBinding.HEADER, InputBindings.resolveBinding(mb, true));
    }

    @Test
    void httpPayloadResolvesToPayload() {
        Model m = modelFor(
                "structure Body { @required name: String }\n" +
                "structure Input { @httpPayload @required body: Body }");
        MemberShape mb = member(m, "Input", "body");
        assertEquals(HttpBinding.PAYLOAD, InputBindings.resolveBinding(mb, true));
    }

    @Test
    void nonAnnotatedGetResolvesToImplicitQuery() {
        Model m = modelFor("structure Input { name: String }");
        MemberShape mb = member(m, "Input", "name");
        assertEquals(HttpBinding.IMPLICIT_QUERY, InputBindings.resolveBinding(mb, false));
    }

    @Test
    void nonAnnotatedPostResolvesToImplicitBody() {
        Model m = modelFor("structure Input { name: String }");
        MemberShape mb = member(m, "Input", "name");
        assertEquals(HttpBinding.IMPLICIT_BODY, InputBindings.resolveBinding(mb, true));
    }

    // ── isBodyMethod ────────────────────────────────────────────────────────────

    @Test
    void postPutPatchAreBodyMethods() {
        assertTrue(InputBindings.isBodyMethod("POST"));
        assertTrue(InputBindings.isBodyMethod("PUT"));
        assertTrue(InputBindings.isBodyMethod("PATCH"));
    }

    @Test
    void getDeleteAreNotBodyMethods() {
        assertFalse(InputBindings.isBodyMethod("GET"));
        assertFalse(InputBindings.isBodyMethod("DELETE"));
        assertFalse(InputBindings.isBodyMethod("HEAD"));
    }

    // ── InputBindings construction ─────────────────────────────────────────────

    @Test
    void httpLabelGoesToPathMembers() {
        Model m = modelFor("structure Input { @httpLabel @required id: String }");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "GET");
        assertTrue(b.pathMembers.containsKey("id"), "id should be in pathMembers");
        assertTrue(b.queryMembers.isEmpty());
        assertTrue(b.headerMembers.isEmpty());
        assertTrue(b.bodyMembers.isEmpty());
    }

    @Test
    void httpQueryGoesToQueryMembers() {
        Model m = modelFor(
                "structure Input {\n" +
                "  @httpQuery(\"limit\") limit: Integer\n" +
                "  @httpQuery(\"page\") page: Integer\n" +
                "}");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "GET");
        assertEquals(2, b.queryMembers.size());
        assertTrue(b.pathMembers.isEmpty());
    }

    @Test
    void httpHeaderGoesToHeaderMembers() {
        Model m = modelFor("structure Input { @httpHeader(\"X-Api-Key\") apiKey: String }");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "GET");
        assertTrue(b.headerMembers.containsKey("apiKey"));
    }

    @Test
    void httpPayloadGoesToBodyWithPayloadName() {
        Model m = modelFor(
                "structure Body { @required name: String }\n" +
                "structure Input { @httpPayload @required body: Body }");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "POST");
        assertTrue(b.hasPayload());
        assertEquals("body", b.payloadMemberName);
        assertTrue(b.bodyMembers.containsKey("body"));
    }

    @Test
    void implicitPostFieldGoesToBody() {
        Model m = modelFor(
                "structure Input {\n" +
                "  @required name: String\n" +
                "  description: String\n" +
                "}");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "POST");
        assertEquals(2, b.bodyMembers.size(), "Both fields go to body for POST");
        assertTrue(b.queryMembers.isEmpty());
        assertFalse(b.hasPayload());
    }

    @Test
    void implicitGetFieldGoesToQuery() {
        Model m = modelFor(
                "structure Input {\n" +
                "  filter: String\n" +
                "  limit: Integer\n" +
                "}");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "GET");
        assertEquals(2, b.queryMembers.size(), "Both fields go to query for GET");
        assertTrue(b.bodyMembers.isEmpty());
    }

    @Test
    void mixedBindingsAreSplitCorrectly() {
        Model m = modelFor(
                "structure Body { @required name: String }\n" +
                "structure Input {\n" +
                "  @httpLabel @required id: String\n" +
                "  @httpQuery(\"format\") format: String\n" +
                "  @httpHeader(\"X-Key\") key: String\n" +
                "  @httpPayload @required body: Body\n" +
                "}");
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        InputBindings b = new InputBindings(s, "POST");
        assertTrue(b.pathMembers.containsKey("id"));
        assertTrue(b.queryMembers.containsKey("format"));
        assertTrue(b.headerMembers.containsKey("key"));
        assertTrue(b.bodyMembers.containsKey("body"));
        assertEquals("body", b.payloadMemberName);
    }
}
