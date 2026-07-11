package com.smithyhono.writers;

import com.smithyhono.ModelIndex;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.RequiredTrait;

import java.util.*;

/**
 * Shared TypeScript type rendering for an operation's input/output, used by BOTH
 * {@link RouteEmitter} (the server operations interface) and {@code ClientEmitter}
 * (the generated client). Keeping this in one place guarantees the client's method
 * signatures match the server's operations interface byte-for-byte — a consumer's
 * {@code XOperations} impl and the {@code createXClient()} return type stay in lockstep.
 */
public final class OperationTypes {
    private OperationTypes() {}

    /**
     * The inline TS type for an operation's handler input — the same shape the server
     * destructures (path + query + header + body members). Header members are always
     * optional ({@code string | undefined}).
     */
    public static String inputType(Model model, ModelIndex index, OperationShape op) {
        Optional<StructureShape> inputOpt = index.getInput(op);
        if (inputOpt.isEmpty()) return "Record<string, never>";

        Map<String, MemberShape> members = inputOpt.get().getAllMembers();
        if (members.isEmpty()) return "Record<string, never>";

        List<String> fields = new ArrayList<>();
        for (Map.Entry<String, MemberShape> entry : members.entrySet()) {
            String name = entry.getKey();
            MemberShape member = entry.getValue();
            Shape target = model.expectShape(member.getTarget());
            boolean required = member.hasTrait(RequiredTrait.class);
            // Header members are always optional from the handler's perspective (string | undefined)
            boolean optional = !required || member.hasTrait(HttpHeaderTrait.class);
            fields.add(name + (optional ? "?" : "") + ": " + toTsType(model, target));
        }
        return "{ " + String.join("; ", fields) + " }";
    }

    /** The TS output type name, or {@code "void"} when the op has no output members. */
    public static String outputType(ModelIndex index, OperationShape op) {
        Optional<StructureShape> outputOpt = index.getOutput(op);
        if (outputOpt.isEmpty()) return "void";
        StructureShape output = outputOpt.get();
        if (output.getAllMembers().isEmpty()) return "void";
        return output.getId().getName();
    }

    public static String toTsType(Model model, Shape shape) {
        return switch (shape.getType()) {
            case STRING, ENUM -> "string";
            case INTEGER, LONG, FLOAT, DOUBLE -> "number";
            case BIG_INTEGER, BIG_DECIMAL -> "string";
            case BOOLEAN -> "boolean";
            case TIMESTAMP -> "string";
            case BLOB -> "string";
            case DOCUMENT -> "unknown";
            case STRUCTURE -> shape.getId().getName();
            // restJson1 single-key union (CG-03): `{ A: T } | { B: T }`. Unions are
            // inlined (no top-level type decl), so emit the structural type here.
            case UNION -> unionTsType(model, shape.asUnionShape().get());
            case LIST -> {
                Shape memberTarget = model.expectShape(shape.asListShape().get().getMember().getTarget());
                yield toTsType(model, memberTarget) + "[]";
            }
            case MAP -> {
                Shape valueTarget = model.expectShape(shape.asMapShape().get().getValue().getTarget());
                yield "Record<string, " + toTsType(model, valueTarget) + ">";
            }
            default -> "unknown";
        };
    }

    /** restJson1 single-key union TS type: `{ A: T } | { B: T }` (CG-03). */
    public static String unionTsType(Model model, UnionShape union) {
        if (union.getAllMembers().isEmpty()) return "never";
        List<String> variants = new ArrayList<>();
        for (Map.Entry<String, MemberShape> entry : union.getAllMembers().entrySet()) {
            Shape target = model.expectShape(entry.getValue().getTarget());
            variants.add("{ " + entry.getKey() + ": " + toTsType(model, target) + " }");
        }
        return String.join(" | ", variants);
    }

    /**
     * The set of named (structure) type IDs that appear in the rendered input/output
     * type strings for the op — i.e. exactly the symbols the client file must import.
     * Mirrors {@link #toTsType}'s recursion: structures are referenced by name (no
     * recursion into them — they're declared elsewhere); unions are inlined so their
     * variant targets are walked; lists/maps recurse into their member/value.
     */
    public static Set<ShapeId> referencedNamedTypes(Model model, ModelIndex index, OperationShape op) {
        Set<ShapeId> acc = new LinkedHashSet<>();
        index.getInput(op).ifPresent(in -> {
            for (MemberShape member : in.getAllMembers().values()) {
                collectNamed(model, model.expectShape(member.getTarget()), acc);
            }
        });
        index.getOutput(op).ifPresent(out -> {
            if (!out.getAllMembers().isEmpty()) acc.add(out.getId());
        });
        return acc;
    }

    private static void collectNamed(Model model, Shape shape, Set<ShapeId> acc) {
        switch (shape.getType()) {
            case STRUCTURE -> acc.add(shape.getId());
            case UNION -> {
                for (MemberShape m : shape.asUnionShape().get().getAllMembers().values()) {
                    collectNamed(model, model.expectShape(m.getTarget()), acc);
                }
            }
            case LIST -> collectNamed(model, model.expectShape(shape.asListShape().get().getMember().getTarget()), acc);
            case MAP -> collectNamed(model, model.expectShape(shape.asMapShape().get().getValue().getTarget()), acc);
            default -> { /* scalar — no named type */ }
        }
    }
}
