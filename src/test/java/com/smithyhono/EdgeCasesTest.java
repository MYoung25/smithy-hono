package com.smithyhono;

import com.smithyhono.writers.SchemaDeclarationEmitter;
import com.smithyhono.writers.TypeScriptFileWriter;
import com.smithyhono.writers.ZodEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class EdgeCasesTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    // ── Recursive shapes ────────────────────────────────────────────────────────

    @Test
    void recursiveShapeEmitsZodLazy() {
        Model m = modelFor(
                "structure TreeNode {\n" +
                "  @required id: String\n" +
                "  @required label: String\n" +
                "  children: TreeNodeList\n" +
                "}\n" +
                "list TreeNodeList { member: TreeNode }");
        StructureShape tree = m.expectShape(ShapeId.from("test#TreeNode"), StructureShape.class);
        SchemaDeclarationEmitter emitter = new SchemaDeclarationEmitter(m);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitDeclarations(List.of(tree), writer);
        String content = writer.getContent();
        assertTrue(content.contains("z.lazy("), "Should wrap recursive shape in z.lazy(): " + content);
        assertTrue(content.contains("export type TreeNode ="),
                "Should emit explicit type declaration for recursive shape: " + content);
    }

    @Test
    void recursiveSchemaHasZodTypeAnnotation() {
        Model m = modelFor(
                "structure Node {\n" +
                "  @required id: String\n" +
                "  children: NodeList\n" +
                "}\n" +
                "list NodeList { member: Node }");
        StructureShape node = m.expectShape(ShapeId.from("test#Node"), StructureShape.class);
        SchemaDeclarationEmitter emitter = new SchemaDeclarationEmitter(m);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitDeclarations(List.of(node), writer);
        String content = writer.getContent();
        assertTrue(content.contains("z.ZodType<Node>"),
                "Should have ZodType annotation to break circular type inference: " + content);
    }

    // ── Mixin shapes ───────────────────────────────────────────────────────────

    @Test
    void mixinShapeIsNotEmittedAsStandaloneSchema() {
        Model m = modelFor(
                "@mixin\n" +
                "structure TimestampedMixin {\n" +
                "  @required createdAt: Timestamp\n" +
                "}\n" +
                "structure Item with [TimestampedMixin] {\n" +
                "  @required id: String\n" +
                "}");
        StructureShape item = m.expectShape(ShapeId.from("test#Item"), StructureShape.class);
        SchemaDeclarationEmitter emitter = new SchemaDeclarationEmitter(m);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitDeclarations(List.of(item), writer);
        String content = writer.getContent();
        assertTrue(content.contains("ItemSchema"), "Item schema should be emitted: " + content);
        assertFalse(content.contains("TimestampedMixin"),
                "Mixin schema should NOT be emitted as standalone: " + content);
    }

    @Test
    void mixinMembersAreInlinedIntoConcreteShape() {
        Model m = modelFor(
                "@mixin\n" +
                "structure TimestampedMixin {\n" +
                "  @required createdAt: Timestamp\n" +
                "}\n" +
                "structure Item with [TimestampedMixin] {\n" +
                "  @required id: String\n" +
                "}");
        StructureShape item = m.expectShape(ShapeId.from("test#Item"), StructureShape.class);
        SchemaDeclarationEmitter emitter = new SchemaDeclarationEmitter(m);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitDeclarations(List.of(item), writer);
        String content = writer.getContent();
        assertTrue(content.contains("createdAt"),
                "Mixin member createdAt should be present in Item schema: " + content);
        assertTrue(content.contains("id"),
                "Own member id should be present in Item schema: " + content);
    }

    // ── Sparse collections ─────────────────────────────────────────────────────

    @Test
    void sparseListMembersAreNullable() {
        Model m = modelFor("@sparse\nlist TagList { member: String }");
        ZodEmitter e = new ZodEmitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#TagList"), ListShape.class);
        String result = e.emitShape(list, null);
        assertEquals("z.array(z.string().nullable())", result);
    }

    @Test
    void regularListMembersAreNotNullable() {
        Model m = modelFor("list TagList { member: String }");
        ZodEmitter e = new ZodEmitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#TagList"), ListShape.class);
        assertEquals("z.array(z.string())", e.emitShape(list, null));
    }

    @Test
    void sparseMapValuesAreNullable() {
        Model m = modelFor("@sparse\nmap Props { key: String\nvalue: Integer }");
        ZodEmitter e = new ZodEmitter(m);
        MapShape map = m.expectShape(ShapeId.from("test#Props"), MapShape.class);
        assertEquals("z.record(z.string(), z.number().int().nullable())", e.emitShape(map, null));
    }

    @Test
    void regularMapValuesAreNotNullable() {
        Model m = modelFor("map Props { key: String\nvalue: String }");
        ZodEmitter e = new ZodEmitter(m);
        MapShape map = m.expectShape(ShapeId.from("test#Props"), MapShape.class);
        assertEquals("z.record(z.string(), z.string())", e.emitShape(map, null));
    }

    // ── SchemaDeclarationEmitter exclusions ────────────────────────────────────

    @Test
    void excludedShapeDeclarationIsSkipped() {
        Model m = modelFor(
                "structure Shared { @required id: String }\n" +
                "structure Local { @required shared: Shared }");
        StructureShape local = m.expectShape(ShapeId.from("test#Local"), StructureShape.class);
        SchemaDeclarationEmitter emitter = new SchemaDeclarationEmitter(m);
        emitter.exclude(java.util.Set.of(ShapeId.from("test#Shared")));
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        emitter.emitDeclarations(List.of(local), writer);
        String content = writer.getContent();
        assertTrue(content.contains("export const LocalSchema"), "Local schema declaration: " + content);
        // Shared is excluded from declarations but still referenced inside LocalSchema
        assertFalse(content.contains("export const SharedSchema"),
                "Shared schema declaration should be skipped: " + content);
        assertTrue(content.contains("shared: SharedSchema"),
                "Shared schema should still be referenced by name: " + content);
    }

    @Test
    void computeReachableIncludesTransitiveShapes() {
        Model m = modelFor(
                "structure A { @required b: B }\n" +
                "structure B { @required c: C }\n" +
                "structure C { @required value: String }");
        StructureShape a = m.expectShape(ShapeId.from("test#A"), StructureShape.class);
        java.util.Set<ShapeId> reachable =
                SchemaDeclarationEmitter.computeReachable(m, List.of(a));
        assertTrue(reachable.contains(ShapeId.from("test#A")));
        assertTrue(reachable.contains(ShapeId.from("test#B")));
        assertTrue(reachable.contains(ShapeId.from("test#C")));
    }
}
