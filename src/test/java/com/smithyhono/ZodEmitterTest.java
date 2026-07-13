package com.smithyhono;

import com.smithyhono.writers.ZodEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.LengthTrait;

import static org.junit.jupiter.api.Assertions.*;

class ZodEmitterTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    private static ZodEmitter emitter(Model m) {
        return new ZodEmitter(m);
    }

    // ── Primitive shapes ───────────────────────────────────────────────────────

    @Test
    void stringEmitsZodString() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        StringShape s = StringShape.builder().id("test#Name").build();
        assertEquals("z.string()", e.emitShape(s, null));
    }

    @Test
    void booleanEmitsZodBoolean() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        BooleanShape s = BooleanShape.builder().id("test#Flag").build();
        assertEquals("z.boolean()", e.emitShape(s, null));
    }

    @Test
    void integerEmitsZodNumberInt() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        IntegerShape s = IntegerShape.builder().id("test#Count").build();
        assertEquals("z.number().int()", e.emitShape(s, null));
    }

    @Test
    void longEmitsZodNumberInt() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        LongShape s = LongShape.builder().id("test#Id").build();
        assertEquals("z.number().int()", e.emitShape(s, null));
    }

    @Test
    void floatEmitsZodNumber() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        FloatShape s = FloatShape.builder().id("test#Score").build();
        assertEquals("z.number()", e.emitShape(s, null));
    }

    @Test
    void doubleEmitsZodNumber() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        DoubleShape s = DoubleShape.builder().id("test#Ratio").build();
        assertEquals("z.number()", e.emitShape(s, null));
    }

    // ── CG-01: coercing emission for string-bound params ─────────────────────────

    @Test
    void coercingIntegerEmitsZodCoerceNumber() {
        // CG-EMIT-1-04 — guarded decimal coercion (not raw z.coerce.number(), which
        // would silently accept "", hex/exponent, whitespace, "Infinity").
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        IntegerShape s = IntegerShape.builder().id("test#Count").build();
        assertEquals("z.string().regex(/^-?\\d+$/).transform(Number).pipe(z.number().int())",
                e.emitShape(s, null, true));
    }

    @Test
    void coercingFloatEmitsZodCoerceNumber() {
        // CG-EMIT-1-04 — guarded decimal coercion for floats.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        FloatShape s = FloatShape.builder().id("test#Score").build();
        assertEquals("z.string().regex(/^-?\\d+(\\.\\d+)?$/).transform(Number).pipe(z.number().finite())",
                e.emitShape(s, null, true));
    }

    @Test
    void coercingBooleanRejectsNonLiteralStrings() {
        // z.coerce.boolean() treats any non-empty string as true; emit an explicit
        // "true"/"false" mapping instead so "false"/"0" don't become true.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        BooleanShape s = BooleanShape.builder().id("test#Flag").build();
        String result = e.emitShape(s, null, true);
        assertEquals("z.enum(['true', 'false']).transform((v) => v === 'true')", result);
    }

    @Test
    void coercingTimestampEmitsZodCoerceDate() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        TimestampShape s = TimestampShape.builder().id("test#At").build();
        assertEquals("z.coerce.date()", e.emitShape(s, null, true));
    }

    @Test
    void rangeOnTargetShapeReachesValidator() {
        // CG-04: @range on the target number shape (not the member) must still emit
        // .min/.max — a reusable constrained type carries the trait on the shape.
        Model m = modelFor(
                "@range(min: 1, max: 50)\ninteger PageSize\n" +
                "structure In { size: PageSize }");
        ZodEmitter e = emitter(m);
        StructureShape in = m.expectShape(ShapeId.from("test#In"), StructureShape.class);
        String result = e.emitStructure(in);
        assertTrue(result.contains("size: z.number().int().min(1).max(50)"),
                "target-shape @range should produce .min/.max: " + result);
    }

    @Test
    void memberRangeWinsOverTargetRange() {
        // Member-level @range takes precedence over the target shape's.
        Model m = modelFor(
                "@range(min: 1, max: 50)\ninteger PageSize\n" +
                "structure In { @range(min: 5, max: 10) size: PageSize }");
        ZodEmitter e = emitter(m);
        StructureShape in = m.expectShape(ShapeId.from("test#In"), StructureShape.class);
        String result = e.emitStructure(in);
        assertTrue(result.contains("size: z.number().int().min(5).max(10)"),
                "member @range should win: " + result);
    }

    @Test
    void nonCoercingNumberIsStrictForBodyMembers() {
        // Body (JSON) members must stay strict — the default (coercing=false) path.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        IntegerShape s = IntegerShape.builder().id("test#Count").build();
        assertEquals("z.number().int()", e.emitShape(s, null, false));
    }

    @Test
    void timestampEmitsZodStringDatetime() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        TimestampShape s = TimestampShape.builder().id("test#CreatedAt").build();
        assertEquals("z.string().datetime()", e.emitShape(s, null));
    }

    @Test
    void blobEmitsBase64String() {
        // CG-10(5) — non-streaming blob is base64-in-JSON; reject non-base64.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        BlobShape s = BlobShape.builder().id("test#Data").build();
        assertEquals("z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)", e.emitShape(s, null));
    }

    @Test
    void bigDecimalEmitsNumericString() {
        // CG-10(4) — bigDecimal is a numeric string; reject non-numeric input.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        BigDecimalShape s = BigDecimalShape.builder().id("test#Amount").build();
        assertEquals("z.string().regex(/^-?\\d+(\\.\\d+)?$/)", e.emitShape(s, null));
    }

    @Test
    void bigIntegerEmitsNumericString() {
        // CG-10(4) — bigInteger is a numeric (integer) string.
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        BigIntegerShape s = BigIntegerShape.builder().id("test#Funds").build();
        assertEquals("z.string().regex(/^-?\\d+$/)", e.emitShape(s, null));
    }

    // ── Constraints ────────────────────────────────────────────────────────────

    @Test
    void stringWithMinLengthEmitsChain() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        StringShape s = StringShape.builder()
                .id("test#Name")
                .addTrait(LengthTrait.builder().min(1L).build())
                .build();
        assertEquals("z.string().min(1)", e.emitShape(s, null));
    }

    @Test
    void stringWithMinMaxLengthEmitsChain() {
        ZodEmitter e = emitter(Model.assembler().assemble().unwrap());
        StringShape s = StringShape.builder()
                .id("test#Name")
                .addTrait(LengthTrait.builder().min(1L).max(100L).build())
                .build();
        assertEquals("z.string().min(1).max(100)", e.emitShape(s, null));
    }

    @Test
    void stringWithPatternEmitsRegex() {
        // CG-EMIT-1-01 — the @pattern is built from an escaped STRING literal via
        // new RegExp("..."), not interpolated into a /.../ literal (a `/` in the
        // pattern would otherwise terminate the literal early).
        Model m = modelFor("@pattern(\"^[a-z]+$\")\nstring Email");
        ZodEmitter e = emitter(m);
        StringShape s = m.expectShape(ShapeId.from("test#Email"), StringShape.class);
        assertEquals("z.string().regex(new RegExp(\"^[a-z]+$\"))", e.emitShape(s, null));
    }

    @Test
    void integerWithRangeOnMemberEmitsMinMax() {
        Model m = modelFor("structure Input { @range(min: 1, max: 10) count: Integer }");
        ZodEmitter e = emitter(m);
        StructureShape s = m.expectShape(ShapeId.from("test#Input"), StructureShape.class);
        String result = e.emitStructure(s);
        assertTrue(result.contains("count: z.number().int().min(1).max(10).optional()"),
                "Expected range constraints in: " + result);
    }

    // ── Structure ──────────────────────────────────────────────────────────────

    @Test
    void structureRequiredMemberHasNoOptional() {
        Model m = modelFor("structure Foo { @required id: String\nname: String }");
        ZodEmitter e = emitter(m);
        StructureShape foo = m.expectShape(ShapeId.from("test#Foo"), StructureShape.class);
        String result = e.emitStructure(foo);
        assertTrue(result.contains("id: z.string()"), "id should be required: " + result);
        assertTrue(result.contains("name: z.string().optional()"), "name should be optional: " + result);
    }

    @Test
    void structureEmitsZodObject() {
        Model m = modelFor("structure Foo { @required id: String }");
        ZodEmitter e = emitter(m);
        StructureShape foo = m.expectShape(ShapeId.from("test#Foo"), StructureShape.class);
        String result = e.emitStructure(foo);
        assertTrue(result.startsWith("z.object({"), "Should be a z.object: " + result);
        assertTrue(result.endsWith("}).strict()"), "Should end with }).strict(): " + result);
    }

    @Test
    void structureIsStrictToRejectUnknownFields() {
        // VAL-03 — mass-assignment defense: generated objects reject extra fields.
        Model m = modelFor("structure Foo { @required id: String }");
        ZodEmitter e = emitter(m);
        StructureShape foo = m.expectShape(ShapeId.from("test#Foo"), StructureShape.class);
        assertTrue(e.emitStructure(foo).contains(".strict()"),
                "Generated objects must be .strict()");
    }

    // ── ReDoS lint (VAL-07) ──────────────────────────────────────────────────────

    @Test
    void catastrophicPatternsAreFlagged() {
        assertTrue(ZodEmitter.looksCatastrophic("(a+)+"), "nested quantifier");
        assertTrue(ZodEmitter.looksCatastrophic("(a*)*"), "nested star");
        assertTrue(ZodEmitter.looksCatastrophic("(a|a)+"), "quantified alternation");
    }

    @Test
    void linearPatternsAreNotFlagged() {
        assertFalse(ZodEmitter.looksCatastrophic("^[a-z]+$"));
        assertFalse(ZodEmitter.looksCatastrophic("\\d{3}-\\d{4}"));
        assertFalse(ZodEmitter.looksCatastrophic("[a-zA-Z0-9_]+"));
    }

    @Test
    void nestedStructureEmitsRefByVarName() {
        Model m = modelFor(
                "structure Inner { @required x: Integer }\n" +
                "structure Outer { @required inner: Inner }");
        ZodEmitter e = emitter(m);
        StructureShape outer = m.expectShape(ShapeId.from("test#Outer"), StructureShape.class);
        String result = e.emitStructure(outer);
        assertTrue(result.contains("inner: InnerSchema"), "Should reference InnerSchema: " + result);
    }

    // ── Enum ───────────────────────────────────────────────────────────────────

    @Test
    void enumShapeEmitsZodEnum() {
        Model m = modelFor("enum Status { ACTIVE\nINACTIVE }");
        ZodEmitter e = emitter(m);
        EnumShape status = m.expectShape(ShapeId.from("test#Status"), EnumShape.class);
        String result = e.emitShape(status, null);
        assertTrue(result.startsWith("z.enum(["), "Should be z.enum: " + result);
        assertTrue(result.contains("\"ACTIVE\""), "Should contain ACTIVE: " + result);
        assertTrue(result.contains("\"INACTIVE\""), "Should contain INACTIVE: " + result);
    }

    @Test
    void explicitValueEnumEmitsWireValuesNotMemberNames() {
        // CG-02: restJson1 sends the VALUE on the wire, so the validator must accept
        // "active"/"inactive" (the values), not "ACTIVE"/"INACTIVE" (the names).
        Model m = modelFor("enum Status {\n  ACTIVE = \"active\"\n  INACTIVE = \"inactive\"\n}");
        ZodEmitter e = emitter(m);
        EnumShape status = m.expectShape(ShapeId.from("test#Status"), EnumShape.class);
        String result = e.emitShape(status, null);
        assertTrue(result.contains("\"active\""), "Should contain wire value active: " + result);
        assertTrue(result.contains("\"inactive\""), "Should contain wire value inactive: " + result);
        assertFalse(result.contains("\"ACTIVE\""), "Should NOT contain member name ACTIVE: " + result);
    }

    @Test
    void intEnumShapeEmitsZodUnionOfLiterals() {
        Model m = modelFor("intEnum Priority {\n  LOW = 1\n  HIGH = 2\n}");
        ZodEmitter e = emitter(m);
        IntEnumShape priority = m.expectShape(ShapeId.from("test#Priority"), IntEnumShape.class);
        String result = e.emitShape(priority, null);
        assertTrue(result.startsWith("z.union(["), "Should be z.union: " + result);
        assertTrue(result.contains("z.literal(1)"), "Should contain literal(1): " + result);
        assertTrue(result.contains("z.literal(2)"), "Should contain literal(2): " + result);
    }

    @Test
    void singleValueIntEnumEmitsLoneLiteralNotUnion() {
        // A one-value intEnum can't be z.union([x]) — z.union needs >=2 options (tsc
        // type error), so emit the lone z.literal directly.
        Model m = modelFor("intEnum Status {\n  ACTIVE = 1\n}");
        ZodEmitter e = emitter(m);
        IntEnumShape status = m.expectShape(ShapeId.from("test#Status"), IntEnumShape.class);
        assertEquals("z.literal(1)", e.emitShape(status, null));
    }

    // ── Union ──────────────────────────────────────────────────────────────────

    @Test
    void singleMemberUnionEmitsLoneObjectNotUnion() {
        // A single-variant union can't be z.union([x]); emit the lone variant object.
        Model m = modelFor("union Wrapper {\n  only: String\n}");
        ZodEmitter e = emitter(m);
        UnionShape wrapper = m.expectShape(ShapeId.from("test#Wrapper"), UnionShape.class);
        String result = e.emitShape(wrapper, null);
        assertFalse(result.contains("z.union("), "single-member union must not wrap in z.union: " + result);
        assertEquals("z.object({ only: z.string() }).strict()", result);
    }

    @Test
    void twoMemberUnionStillEmitsZodUnion() {
        Model m = modelFor("union Wrapper {\n  a: String\n  b: Integer\n}");
        ZodEmitter e = emitter(m);
        UnionShape wrapper = m.expectShape(ShapeId.from("test#Wrapper"), UnionShape.class);
        String result = e.emitShape(wrapper, null);
        assertTrue(result.startsWith("z.union(["), "multi-member union must be z.union: " + result);
    }

    // ── Collections ────────────────────────────────────────────────────────────

    @Test
    void listShapeEmitsZodArray() {
        Model m = modelFor("list Tags { member: String }");
        ZodEmitter e = emitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#Tags"), ListShape.class);
        assertEquals("z.array(z.string())", e.emitShape(list, null));
    }

    @Test
    void sparseListMemberIsNullable() {
        Model m = modelFor("@sparse\nlist Tags { member: String }");
        ZodEmitter e = emitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#Tags"), ListShape.class);
        assertEquals("z.array(z.string().nullable())", e.emitShape(list, null));
    }

    @Test
    void mapShapeEmitsZodRecord() {
        Model m = modelFor("map Props { key: String\nvalue: Integer }");
        ZodEmitter e = emitter(m);
        MapShape map = m.expectShape(ShapeId.from("test#Props"), MapShape.class);
        assertEquals("z.record(z.string(), z.number().int())", e.emitShape(map, null));
    }

    @Test
    void sparseMapValueIsNullable() {
        Model m = modelFor("@sparse\nmap Props { key: String\nvalue: Integer }");
        ZodEmitter e = emitter(m);
        MapShape map = m.expectShape(ShapeId.from("test#Props"), MapShape.class);
        assertEquals("z.record(z.string(), z.number().int().nullable())", e.emitShape(map, null));
    }

    @Test
    void coercingListThreadsCoercionToElements() {
        // A list bound to @httpQuery/@httpHeader delivers string elements on the wire;
        // the coercing flag must reach the element schema (else valid input 400s).
        Model m = modelFor("list Ids { member: Integer }");
        ZodEmitter e = emitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#Ids"), ListShape.class);
        assertEquals(
                "z.array(z.string().regex(/^-?\\d+$/).transform(Number).pipe(z.number().int()))",
                e.emitShape(list, null, true));
    }

    @Test
    void nonCoercingListStaysStrictForBody() {
        // Body-nested collections keep strict (non-coercing) element schemas.
        Model m = modelFor("list Ids { member: Integer }");
        ZodEmitter e = emitter(m);
        ListShape list = m.expectShape(ShapeId.from("test#Ids"), ListShape.class);
        assertEquals("z.array(z.number().int())", e.emitShape(list, null, false));
    }

    @Test
    void coercingMapThreadsCoercionToValues() {
        Model m = modelFor("map Counts { key: String\nvalue: Integer }");
        ZodEmitter e = emitter(m);
        MapShape map = m.expectShape(ShapeId.from("test#Counts"), MapShape.class);
        assertEquals(
                "z.record(z.string(), z.string().regex(/^-?\\d+$/).transform(Number).pipe(z.number().int()))",
                e.emitShape(map, null, true));
    }

    // ── Reserved names ─────────────────────────────────────────────────────────

    @Test
    void reservedTsNameGetsSuffix() {
        assertEquals("ErrorShape", ZodEmitter.safeTypeName("Error"));
        assertEquals("ObjectShape", ZodEmitter.safeTypeName("Object"));
        assertEquals("ArrayShape", ZodEmitter.safeTypeName("Array"));
    }

    @Test
    void nonReservedNameIsUnchanged() {
        assertEquals("Playthrough", ZodEmitter.safeTypeName("Playthrough"));
        assertEquals("MyError", ZodEmitter.safeTypeName("MyError"));
    }

    @Test
    void schemaVarNameAppendsSchema() {
        assertEquals("PlaythroughSchema", ZodEmitter.schemaVarName("Playthrough"));
        assertEquals("ErrorShapeSchema", ZodEmitter.schemaVarName("Error"));
    }

    // ── @pattern Java→JS compatibility lint (CG-EMIT-1-01) ─────────────────────

    /** Emit `shapeId` (coercing=false) while capturing the JUL WARNING messages. */
    private static java.util.List<String> warningsForEmit(Model m, String shapeId) {
        java.util.logging.Logger logger =
                java.util.logging.Logger.getLogger(ZodEmitter.class.getName());
        java.util.List<String> warnings = new java.util.ArrayList<>();
        java.util.logging.Handler handler = new java.util.logging.Handler() {
            @Override public void publish(java.util.logging.LogRecord r) {
                if (r.getLevel().intValue() >= java.util.logging.Level.WARNING.intValue()) {
                    warnings.add(r.getMessage());
                }
            }
            @Override public void flush() {}
            @Override public void close() {}
        };
        logger.addHandler(handler);
        try {
            Shape s = m.expectShape(ShapeId.from("test#" + shapeId));
            emitter(m).emitShape(s, null);
        } finally {
            logger.removeHandler(handler);
        }
        return warnings;
    }

    @Test
    void patternWithInlineFlagGroupWarnsJsIncompat() {
        Model m = modelFor("@pattern(\"(?i)abc\")\n@length(min: 1, max: 8)\nstring Flagged\n");
        java.util.List<String> warnings = warningsForEmit(m, "Flagged");
        assertTrue(
                warnings.stream().anyMatch(w -> w.contains("CG-EMIT-1-01") && w.contains("inline flag group")),
                "expected a CG-EMIT-1-01 inline-flag-group warning, got: " + warnings);
    }

    @Test
    void jsCompatiblePatternEmitsNoCompatWarning() {
        Model m = modelFor("@pattern(\"^[a-z]+$\")\n@length(min: 1, max: 8)\nstring Clean\n");
        java.util.List<String> warnings = warningsForEmit(m, "Clean");
        assertFalse(
                warnings.stream().anyMatch(w -> w.contains("CG-EMIT-1-01")),
                "a JS-compatible @pattern must not trip the compat lint, got: " + warnings);
    }
}
