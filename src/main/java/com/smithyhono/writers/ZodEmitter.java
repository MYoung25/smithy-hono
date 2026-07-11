package com.smithyhono.writers;

import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.*;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

public class ZodEmitter {
    private final Model model;

    private static final java.util.logging.Logger LOGGER =
        java.util.logging.Logger.getLogger(ZodEmitter.class.getName());

    // TypeScript/JS global names that would shadow a built-in type if used as a
    // generated type name (CG-09). A struct named `Number`/`String`/`Record` etc.
    // is suffixed with "Shape" so it never shadows the global.
    private static final Set<String> TS_RESERVED = Set.of(
        "Error", "Object", "Array", "Function", "Promise",
        "Date", "Map", "Set", "undefined", "null",
        "Number", "String", "Boolean", "Symbol", "BigInt",
        "Record", "RegExp", "WeakMap", "WeakSet", "Math",
        "JSON", "Infinity", "NaN", "globalThis"
    );

    // JS reserved words / keywords that, as an object KEY, are quoted to keep the
    // emitted literal unambiguous and valid (CG-09). Normal identifiers stay bare,
    // so existing snapshots don't churn.
    private static final Set<String> JS_KEYWORDS = Set.of(
        "break", "case", "catch", "class", "const", "continue", "debugger",
        "default", "delete", "do", "else", "enum", "export", "extends", "false",
        "finally", "for", "function", "if", "import", "in", "instanceof", "new",
        "null", "return", "super", "switch", "this", "throw", "true", "try",
        "typeof", "var", "void", "while", "with", "let", "static", "yield",
        "await", "implements", "interface", "package", "private", "protected",
        "public"
    );

    /**
     * Emits an object key, quoting it when the name is a JS keyword or not a plain
     * identifier so the generated literal is always valid (CG-09). A normal
     * identifier is emitted bare (no snapshot churn).
     */
    public static String tsKey(String name) {
        boolean plainIdent = name.matches("[A-Za-z_$][A-Za-z0-9_$]*");
        return (!plainIdent || JS_KEYWORDS.contains(name)) ? "\"" + name + "\"" : name;
    }

    public ZodEmitter(Model model) {
        this.model = model;
    }

    /** Appends "Shape" suffix to names that conflict with TypeScript built-ins. */
    public static String safeTypeName(String smithyName) {
        return TS_RESERVED.contains(smithyName) ? smithyName + "Shape" : smithyName;
    }

    public static String schemaVarName(String shapeName) {
        return safeTypeName(shapeName) + "Schema";
    }

    public String emitShape(Shape shape, MemberShape member) {
        return emitShape(shape, member, false);
    }

    /**
     * Emits a Zod schema for {@code shape}. When {@code coercing} is true the scalar
     * leaves (number/boolean/timestamp) coerce from their STRING wire form — used for
     * members bound to {@code @httpLabel}/{@code @httpQuery}/{@code @httpHeader}, which
     * Hono always delivers as strings (CG-01). JSON body members pass {@code false} so
     * a string-form number/boolean in the body is still rejected.
     */
    public String emitShape(Shape shape, MemberShape member, boolean coercing) {
        return switch (shape.getType()) {
            case STRING     -> emitString(shape.asStringShape().get(), member);
            case INTEGER,
             LONG           -> emitNumberInt(shape, member, coercing);
            case FLOAT,
             DOUBLE         -> emitNumber(shape, member, coercing);
            case BOOLEAN    -> coercing ? coercingBoolean() : "z.boolean()";
            case TIMESTAMP  -> emitTimestamp(shape, member, coercing);
            case BLOB       -> emitBlob(shape.asBlobShape().get());
            case DOCUMENT   -> "z.unknown()";
            case BIG_INTEGER -> emitBigNum(shape, member, true);
            case BIG_DECIMAL -> emitBigNum(shape, member, false);
            case STRUCTURE  -> emitStructureRef(shape.asStructureShape().get());
            case LIST       -> emitList(shape.asListShape().get(), coercing);
            case MAP        -> emitMap(shape.asMapShape().get(), coercing);
            case UNION      -> emitUnion(shape.asUnionShape().get());
            case ENUM       -> emitEnum(shape.asEnumShape().get());
            case INT_ENUM   -> emitIntEnum(shape.asIntEnumShape().get());
            default         -> "z.unknown()";
        };
    }

    public String emitStructure(StructureShape shape) {
        StringBuilder sb = new StringBuilder("z.object({\n");
        for (Map.Entry<String, MemberShape> entry : shape.getAllMembers().entrySet()) {
            String fieldName = entry.getKey();
            MemberShape member = entry.getValue();
            Shape target = model.expectShape(member.getTarget());

            // @sensitive may be on the member or on the target type shape
            if (member.hasTrait(SensitiveTrait.class) || target.hasTrait(SensitiveTrait.class)) {
                sb.append("  /** @sensitive — excluded from debug logs */\n");
            }

            String zodExpr = emitShape(target, member);
            if (member.hasTrait(DefaultTrait.class)) {
                Node defaultNode = member.expectTrait(DefaultTrait.class).toNode();
                zodExpr += ".default(" + nodeToJsLiteral(defaultNode) + ")";
            } else if (!member.hasTrait(RequiredTrait.class)) {
                zodExpr += ".optional()";
            }

            sb.append("  ").append(tsKey(fieldName)).append(": ").append(zodExpr).append(",\n");
        }
        // .strict() rejects unknown/extra fields (VAL-03 — mass-assignment defense).
        sb.append("}).strict()");
        return sb.toString();
    }

    private String emitString(StringShape shape, MemberShape member) {
        String base = "z.string()";
        boolean hasLength = shape.hasTrait(LengthTrait.class);
        if (hasLength) {
            LengthTrait t = shape.expectTrait(LengthTrait.class);
            if (t.getMin().isPresent()) base += ".min(" + t.getMin().get() + ")";
            if (t.getMax().isPresent()) base += ".max(" + t.getMax().get() + ")";
        }
        if (shape.hasTrait(PatternTrait.class)) {
            String regex = shape.expectTrait(PatternTrait.class).getPattern().pattern();
            // VAL-07 — flag catastrophic-backtracking regex shapes at build time.
            lintPattern(shape.getId().getName(), regex, hasLength);
            // CG-EMIT-1-01 — @pattern is a java.util.regex pattern; some Java-valid
            // constructs are invalid or behave differently under JS `new RegExp(...)`.
            // Warn at generation time; the emitted regex is unchanged (contract-preserving).
            lintJsRegexCompat(shape.getId().getName(), regex);
            // CG-EMIT-1-01 — build the RegExp from an escaped STRING literal instead of
            // interpolating the raw pattern into a /.../ literal: a `/` (or any other
            // delimiter-breaking char) in the pattern would otherwise terminate the
            // literal early, producing a syntax error (build DoS) or a silently weaker
            // regex (validation bypass). jsStringLiteral escapes `\`, quotes, newlines.
            base += ".regex(new RegExp(" + jsStringLiteral(regex) + "))";
        } else if (!hasLength) {
            // VAL-01 — unconstrained string: no @length cap, unbounded input.
            lintUnconstrained("string", shape.getId().getName());
        }
        return base;
    }

    // ── Build-time lints (warnings, not failures) ───────────────────────────────

    /**
     * VAL-07: warns about @pattern regexes with catastrophic-backtracking shapes
     * (nested quantifiers, overlapping alternation under a quantifier). The mitigation
     * is length-bounding (@length) + pattern review — RE2 is out of scope (ARCH-01).
     */
    private void lintPattern(String shapeName, String regex, boolean hasLength) {
        if (looksCatastrophic(regex)) {
            LOGGER.warning(String.format(
                "@pattern on '%s' has a catastrophic-backtracking shape (VAL-07): /%s/. "
                + "Keep the pattern linear%s.",
                shapeName, regex,
                hasLength ? "" : " and add @length to bound input size"));
        }
    }

    /**
     * CG-EMIT-1-01: warns when a Java {@code @pattern} regex uses constructs that are
     * invalid or semantically different under JS {@code new RegExp(...)} (which the
     * generated validator uses). Inline-flag groups ({@code (?i)}) and possessive
     * quantifiers ({@code a++}, {@code a*+}) throw a SyntaxError at module load; Unicode
     * property escapes ({@code \p{...}}) match literally without the {@code u} flag. A
     * full Java→JS translation is out of scope — the warning is the contract-preserving
     * minimum (the emitted regex is unchanged).
     */
    private void lintJsRegexCompat(String shapeName, String regex) {
        List<String> issues = new java.util.ArrayList<>();
        // Inline flag groups: (?i), (?s), (?m), (?imsx-...), and (?idmsux:...) — JS has no
        // in-pattern flags. Named groups (?<name>...) and lookarounds are NOT matched here.
        if (regex.matches(".*\\(\\?[a-zA-Z]*[-:)].*") && !regex.matches(".*\\(\\?<[a-zA-Z].*")) {
            // Exclude the JS-legal non-capturing (?:...) and lookahead/behind (?=,(?!,(?<=,(?<!.
            if (regex.matches(".*\\(\\?[idmsuxU]+[-:)].*") || regex.matches(".*\\(\\?-[idmsuxU]+[:)].*")) {
                issues.add("inline flag group ((?i)/(?s)/...) — unsupported in JS RegExp");
            }
        }
        // Possessive quantifiers: a quantifier immediately followed by '+' (e.g. a++, a*+,
        // a?+, a{2,}+). JS has no possessive quantifiers and throws on them.
        if (regex.matches(".*[*+?}]\\+.*")) {
            issues.add("possessive quantifier (e.g. a++, a*+) — unsupported in JS RegExp");
        }
        // Unicode property escapes without a `u` flag match literally in JS (the emit has
        // no `u` flag), silently weakening the pattern.
        if (regex.matches(".*\\\\[pP]\\{.*")) {
            issues.add("\\p{...}/\\P{...} without the `u` flag — matches literally in JS");
        }
        if (!issues.isEmpty()) {
            LOGGER.warning(String.format(
                "@pattern on '%s' uses Java-regex constructs that differ under JS RegExp "
                + "(CG-EMIT-1-01): /%s/ — %s. The generated validator uses `new RegExp(...)`; "
                + "rewrite the pattern in JS-compatible syntax.",
                shapeName, regex, String.join("; ", issues)));
        }
    }

    /** VAL-01: warns about unbounded string/blob/list shapes that omit a size cap. */
    private void lintUnconstrained(String kind, String shapeName) {
        LOGGER.warning(String.format(
            "Unconstrained %s '%s' (VAL-01): no @length cap — input size is unbounded. "
            + "Add @length to limit it.", kind, shapeName));
    }

    /**
     * Heuristic for catastrophic backtracking: a quantifier applied to a group that
     * itself contains a quantifier ((a+)+, (a*)*, (a+)* etc.), or quantified
     * alternation that can match the same input two ways ((a|a)+). Conservative —
     * surfaces likely-risky patterns for review, not a proof of ReDoS.
     */
    public static boolean looksCatastrophic(String regex) {
        // nested quantifier: a group ending in a quantifier, immediately re-quantified.
        if (regex.matches(".*\\([^()]*[*+][^()]*\\)\\s*[*+].*")) return true;
        // quantified group containing alternation: (...|...) followed by * or +.
        if (regex.matches(".*\\([^()]*\\|[^()]*\\)[*+].*")) return true;
        return false;
    }

    private String emitNumberInt(Shape target, MemberShape member, boolean coercing) {
        if (coercing) {
            return coercingNumber(target, member, true);
        }
        return appendRange("z.number().int()", effectiveRange(target, member));
    }

    private String emitNumber(Shape target, MemberShape member, boolean coercing) {
        if (coercing) {
            return coercingNumber(target, member, false);
        }
        return appendRange("z.number()", effectiveRange(target, member));
    }

    /**
     * CG-EMIT-1-04 — guarded string→number coercion for string-bound params
     * (@httpLabel/@httpQuery/@httpHeader). Raw {@code z.coerce.number()} runs
     * {@code Number(input)}, which silently accepts {@code ""}→0, hex/binary/octal
     * ({@code "0x1F"}), exponent ({@code "1e3"}), whitespace, and {@code "Infinity"}.
     * Mirroring the deliberate {@code coercingBoolean()} treatment, accept only a
     * decimal numeric wire form via regex, then transform to a finite number and
     * apply {@code @range}.
     */
    private String coercingNumber(Shape target, MemberShape member, boolean isInteger) {
        String regex = isInteger ? "/^-?\\d+$/" : "/^-?\\d+(\\.\\d+)?$/";
        String numberCheck = appendRange(isInteger ? "z.number().int()" : "z.number().finite()",
            effectiveRange(target, member));
        return "z.string().regex(" + regex + ").transform(Number).pipe(" + numberCheck + ")";
    }

    /**
     * Resolves {@code @range} member-first, then the target shape (CG-04) — mirroring
     * {@code ModelIndex.rangeMax}. A reusable constrained number type
     * (`@range integer PageSize`) carries the trait on the shape, not the member.
     */
    private static Optional<RangeTrait> effectiveRange(Shape target, MemberShape member) {
        if (member != null && member.hasTrait(RangeTrait.class)) {
            return Optional.of(member.expectTrait(RangeTrait.class));
        }
        if (target != null && target.hasTrait(RangeTrait.class)) {
            return Optional.of(target.expectTrait(RangeTrait.class));
        }
        return Optional.empty();
    }

    private static String appendRange(String base, Optional<RangeTrait> range) {
        if (range.isPresent()) {
            RangeTrait t = range.get();
            if (t.getMin().isPresent()) base += ".min(" + t.getMin().get() + ")";
            if (t.getMax().isPresent()) base += ".max(" + t.getMax().get() + ")";
        }
        return base;
    }

    /**
     * Coercing boolean for string-bound params (CG-01). {@code z.coerce.boolean()} is
     * unsafe — it treats ANY non-empty string ("false", "0") as {@code true} — so we
     * accept only the literal wire forms "true"/"false" and map them explicitly.
     */
    private String coercingBoolean() {
        return "z.enum(['true', 'false']).transform((v) => v === 'true')";
    }

    /**
     * CG-10(1) — honor {@code @timestampFormat} (member-then-target). restJson1's
     * default is epoch-seconds, but this generator's established convention (and the
     * example/handlers) is ISO date-time, so the DEFAULT stays {@code date-time}; an
     * explicit {@code @timestampFormat} is now respected instead of silently ignored.
     */
    private String emitTimestamp(Shape target, MemberShape member, boolean coercing) {
        String format = "date-time";
        if (member != null && member.hasTrait(TimestampFormatTrait.class)) {
            format = member.expectTrait(TimestampFormatTrait.class).getValue();
        } else if (target.hasTrait(TimestampFormatTrait.class)) {
            format = target.expectTrait(TimestampFormatTrait.class).getValue();
        }
        return switch (format) {
            case "epoch-seconds" -> coercing ? "z.coerce.number()" : "z.number()";
            // CG-EMIT-1-05 — a non-coercing (JSON-body) http-date member was validated
            // as an arbitrary string. Match the RFC 7231 IMF-fixdate form restJson1 uses
            // and reject impossible dates (e.g. "32 Foo") via Date.parse.
            case "http-date"     -> coercing ? "z.coerce.date()"
                : "z.string().regex(/^[A-Z][a-z]{2}, \\d{2} [A-Z][a-z]{2} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$/)"
                  + ".refine((s) => !Number.isNaN(Date.parse(s)))";
            default              -> coercing ? "z.coerce.date()" : "z.string().datetime()";
        };
    }

    /**
     * CG-10(4) — bigInteger/bigDecimal carry arbitrary-precision numbers as JSON
     * strings (JS has no native bignum), but the schema accepted ANY string. Emit a
     * numeric-string regex so a non-numeric value is rejected; {@code @range} (if
     * present) is enforced via a BigInt refine for integers.
     */
    private String emitBigNum(Shape target, MemberShape member, boolean isInteger) {
        String regex = isInteger ? "/^-?\\d+$/" : "/^-?\\d+(\\.\\d+)?$/";
        String base = "z.string().regex(" + regex + ")";
        // CG-EMIT-1-08 — resolve @range for BOTH bigInteger and bigDecimal. The integer
        // path keeps exact arbitrary-precision BigInt comparisons; bigDecimal carries a
        // fractional value BigInt can't hold, so it compares via Number(s) (consistent
        // with appendRange's posture for ordinary numbers).
        Optional<RangeTrait> range = effectiveRange(target, member);
        if (range.isPresent()) {
            RangeTrait t = range.get();
            List<String> checks = new java.util.ArrayList<>();
            if (isInteger) {
                t.getMin().ifPresent(min -> checks.add("BigInt(s) >= " + min.toBigInteger() + "n"));
                t.getMax().ifPresent(max -> checks.add("BigInt(s) <= " + max.toBigInteger() + "n"));
            } else {
                t.getMin().ifPresent(min -> checks.add("Number(s) >= " + min));
                t.getMax().ifPresent(max -> checks.add("Number(s) <= " + max));
            }
            if (!checks.isEmpty()) {
                base += ".refine((s) => " + String.join(" && ", checks) + ")";
            }
        }
        return base;
    }

    private String emitBlob(BlobShape shape) {
        // CG-10(5) — a @streaming blob is a raw request/response body stream, not a
        // base64-in-JSON value, so it stays an opaque string passthrough.
        if (shape.hasTrait(StreamingTrait.class)) {
            return "z.string()";
        }
        // VAL-01 — unconstrained blob: no @length cap, unbounded byte input.
        if (!shape.hasTrait(LengthTrait.class)) {
            lintUnconstrained("blob", shape.getId().getName());
        }
        // CG-10(5) — restJson1 encodes a non-streaming blob as base64 in JSON; reject
        // non-base64 input instead of accepting any string.
        return "z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)";
    }

    private String emitStructureRef(StructureShape shape) {
        return schemaVarName(shape.getId().getName());
    }

    private String emitList(ListShape shape, boolean coercing) {
        Shape memberTarget = model.expectShape(shape.getMember().getTarget());
        String inner = emitShape(memberTarget, shape.getMember(), coercing);
        // @sparse allows null members
        if (shape.hasTrait(SparseTrait.class)) inner += ".nullable()";
        String base = "z.array(" + inner + ")";

        if (shape.hasTrait(LengthTrait.class)) {
            LengthTrait length = shape.expectTrait(LengthTrait.class);
            if (length.getMin().isPresent()) base += ".min(" + length.getMin().get() + ")";
            if (length.getMax().isPresent()) base += ".max(" + length.getMax().get() + ")";
        } else {
            // VAL-01 — unconstrained list: no @length cap, unbounded element count.
            lintUnconstrained("list", shape.getId().getName());
        }

        // CG-10(2) — @uniqueItems (set semantics) was counted by the registry but not
        // enforced; reject duplicates (by value, so it works for complex elements too).
        if (shape.hasTrait(UniqueItemsTrait.class)) {
            base += ".refine((a) => new Set(a.map((x) => JSON.stringify(x))).size === a.length,"
                + " { message: 'items must be unique' })";
        }

        return base;
    }

    private String emitMap(MapShape shape, boolean coercing) {
        // CG-10(3) — emit the KEY shape's schema instead of always z.string(), so an
        // enum-/length-/pattern-constrained map key is actually enforced.
        Shape keyTarget = model.expectShape(shape.getKey().getTarget());
        String keyExpr = emitShape(keyTarget, shape.getKey(), coercing);
        Shape valueTarget = model.expectShape(shape.getValue().getTarget());
        String valueExpr = emitShape(valueTarget, shape.getValue(), coercing);
        // @sparse allows null values
        if (shape.hasTrait(SparseTrait.class)) valueExpr += ".nullable()";
        return "z.record(" + keyExpr + ", " + valueExpr + ")";
    }

    private String emitUnion(UnionShape shape) {
        // restJson1 serializes a union as a SINGLE-KEY object `{ "Variant": value }`,
        // not `{ type, value }` (CG-03). Each variant is a `.strict()` object with its
        // one required key, so `{}` (no variant) and `{A,B}` (two variants) are both
        // rejected — exactly-one-variant is enforced without an explicit refine.
        List<String> variants = shape.getAllMembers().entrySet().stream()
            .map(entry -> {
                Shape target = model.expectShape(entry.getValue().getTarget());
                String inner = emitShape(target, entry.getValue());
                return "z.object({ " + entry.getKey() + ": " + inner + " }).strict()";
            })
            .collect(Collectors.toList());
        // A single-variant union is exactly its one variant object; z.union requires
        // >=2 options (its type is a min-2 tuple), so a one-element array is a tsc error.
        if (variants.size() == 1) {
            return variants.get(0);
        }
        return "z.union([\n  " + String.join(",\n  ", variants) + "\n])";
    }

    private String emitEnum(EnumShape shape) {
        // restJson1 sends the enum member's VALUE on the wire, not its name. For
        // implicit enums name == value, but for explicit-value enums
        // (`ACTIVE = "active"`) the validator must accept "active", not "ACTIVE".
        // CG-EMIT-1-02 — route every value through the existing escaper instead of
        // hand-built quotes: a `"`/`\`/newline would break the module, and a `", "`
        // sequence could split one declared member into several accepted ones.
        List<String> values = shape.getEnumValues().values().stream()
            .map(ZodEmitter::jsStringLiteral)
            .collect(Collectors.toList());
        return "z.enum([" + String.join(", ", values) + "])";
    }

    private String emitIntEnum(IntEnumShape shape) {
        List<String> literals = shape.getEnumValues().values().stream()
            .map(v -> "z.literal(" + v + ")")
            .collect(Collectors.toList());
        // A single-value intEnum is exactly its one literal; z.union requires >=2
        // options, so emit the lone z.literal directly to stay valid TypeScript.
        if (literals.size() == 1) {
            return literals.get(0);
        }
        return "z.union([" + String.join(", ", literals) + "])";
    }

    /**
     * Converts a Smithy Node (from {@code @default}) to a JS literal (CG-10(6)).
     * Arrays/objects were previously collapsed to {@code null} (so {@code @default([])}
     * emitted {@code .default(null)}) and strings were unescaped (breaking on
     * {@code "}/newline); both are now handled.
     */
    private static String nodeToJsLiteral(Node node) {
        if (node.isNullNode()) return "null";
        if (node.isBooleanNode()) return String.valueOf(node.expectBooleanNode().getValue());
        if (node.isNumberNode()) return node.expectNumberNode().getValue().toString();
        if (node.isStringNode()) return jsStringLiteral(node.expectStringNode().getValue());
        if (node.isArrayNode()) {
            List<String> els = node.expectArrayNode().getElements().stream()
                .map(ZodEmitter::nodeToJsLiteral)
                .collect(Collectors.toList());
            return "[" + String.join(", ", els) + "]";
        }
        if (node.isObjectNode()) {
            List<String> entries = new java.util.ArrayList<>();
            node.expectObjectNode().getStringMap()
                .forEach((k, v) -> entries.add(jsStringLiteral(k) + ": " + nodeToJsLiteral(v)));
            return "{ " + String.join(", ", entries) + " }";
        }
        return "null";
    }

    /** Emits a JS double-quoted string literal with the breaking characters escaped. */
    private static String jsStringLiteral(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    /**
     * Emits a JS single-quoted string literal with the breaking characters escaped
     * (CG-EMIT-1-07). Wire names (@httpQuery/@httpHeader/@httpPrefixHeaders) are
     * interpolated into {@code '...'} literals in RouteEmitter; an unescaped {@code '}
     * or {@code \} would terminate the literal early (syntax-error module / build DoS)
     * or alter a query-exclusion filter. Route every wire-name interpolation through
     * this helper.
     */
    public static String jsSingleQuoted(String s) {
        StringBuilder sb = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\'' -> sb.append("\\'");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\u2028' -> sb.append("\\u2028");
                case '\u2029' -> sb.append("\\u2029");
                default -> sb.append(c);
            }
        }
        return sb.append("'").toString();
    }
}
