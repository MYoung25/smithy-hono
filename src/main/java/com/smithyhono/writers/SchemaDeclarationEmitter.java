package com.smithyhono.writers;

import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.*;

import java.util.*;

/**
 * Topologically sorts all StructureShapes reachable from a set of root shapes,
 * then emits named Zod schema declarations in dependency order.
 *
 * Lists, maps, and unions are inlined at usage sites — only structures get
 * top-level "export const XyzSchema" declarations to avoid duplication.
 *
 * Phase 8 additions:
 *   - @mixin shapes are skipped (resolved by the Smithy compiler before we see the model)
 *   - Recursive shapes are wrapped in z.lazy() with an explicit z.ZodType<T> annotation
 *   - excludedShapes allows shared shapes emitted in shared.gen.ts to be skipped here
 *   - computeReachable() enables shared-shape detection without a separate pre-pass class
 */
public class SchemaDeclarationEmitter {
    private final Model model;
    private final ZodEmitter zodEmitter;
    private final Set<ShapeId> visited = new LinkedHashSet<>();
    private final Set<ShapeId> inProgress = new HashSet<>();
    private final Set<ShapeId> recursiveShapes = new HashSet<>();
    private Set<ShapeId> excludedShapes = Set.of();

    public SchemaDeclarationEmitter(Model model) {
        this.model = model;
        this.zodEmitter = new ZodEmitter(model);
    }

    /**
     * Marks these shape IDs as already emitted elsewhere (shared.gen.ts).
     * They are skipped during emitDeclarations() but still traversed for ordering.
     */
    public void exclude(Set<ShapeId> shapeIds) {
        this.excludedShapes = shapeIds;
    }

    /**
     * Returns all StructureShape IDs transitively reachable from the given roots.
     * Used by HonoCodegenPlugin to detect shapes shared across resource groups.
     */
    public static Set<ShapeId> computeReachable(Model model, Collection<StructureShape> roots) {
        SchemaDeclarationEmitter helper = new SchemaDeclarationEmitter(model);
        for (StructureShape root : roots) {
            helper.visitStruct(root.getId());
        }
        return Collections.unmodifiableSet(new LinkedHashSet<>(helper.visited));
    }

    public void emitDeclarations(Collection<StructureShape> roots, TypeScriptFileWriter writer) {
        for (StructureShape root : roots) {
            visitStruct(root.getId());
        }

        for (ShapeId id : visited) {
            if (excludedShapes.contains(id)) continue;

            Shape shape = model.expectShape(id);
            if (!(shape instanceof StructureShape struct)) continue;
            if (struct.hasTrait(MixinTrait.class)) continue;

            String safeName = ZodEmitter.safeTypeName(struct.getId().getName());
            String varName = safeName + "Schema";
            String typeName = safeName;

            if (recursiveShapes.contains(id)) {
                // z.lazy() is required because TypeScript cannot infer the type of a
                // self-referencing z.lazy() value — we must emit the type separately first.
                writer.line("export type " + typeName + " = " + buildTypeDeclaration(struct));
                writer.line("export const " + varName + ": z.ZodType<" + typeName + "> = z.lazy(() => "
                    + zodEmitter.emitStructure(struct) + ")");
            } else {
                String zodExpr = zodEmitter.emitStructure(struct);
                writer.line("export const " + varName + " = " + zodExpr);
                writer.line("export type " + typeName + " = z.infer<typeof " + varName + ">");
            }
            writer.blank();
        }
    }

    /**
     * DFS over a struct's members. Adds this struct to visited after all dependencies.
     * inProgress detects cycles; recursive shapes are marked and still emitted via z.lazy().
     */
    private void visitStruct(ShapeId id) {
        if (visited.contains(id)) return;
        if (inProgress.contains(id)) {
            // Back-edge: this shape references itself (directly or transitively).
            // Mark it so emitDeclarations() wraps it in z.lazy().
            recursiveShapes.add(id);
            return;
        }
        inProgress.add(id);

        Shape shape = model.expectShape(id);
        if (shape instanceof StructureShape struct) {
            if (struct.hasTrait(MixinTrait.class)) {
                // Mixin shapes are infrastructure — Smithy already inlined their members
                // into concrete shapes via getAllMembers(). Skip the mixin type itself.
                inProgress.remove(id);
                return;
            }
            for (MemberShape member : struct.getAllMembers().values()) {
                visitReachable(member.getTarget());
            }
            visited.add(id);
        }

        inProgress.remove(id);
    }

    /** Traverses through list/map/union containers to find nested structs. */
    private void visitReachable(ShapeId id) {
        Shape shape = model.expectShape(id);
        if (shape instanceof StructureShape) {
            visitStruct(id);
        } else if (shape instanceof ListShape list) {
            visitReachable(list.getMember().getTarget());
        } else if (shape instanceof MapShape map) {
            visitReachable(map.getValue().getTarget());
        } else if (shape instanceof UnionShape union) {
            for (MemberShape m : union.getAllMembers().values()) {
                visitReachable(m.getTarget());
            }
        }
    }

    /**
     * Builds a plain TypeScript type declaration for a recursive structure.
     * Cannot use z.infer<typeof Schema> because the schema uses z.ZodType<T>,
     * which would be a circular reference.
     */
    private String buildTypeDeclaration(StructureShape struct) {
        StringBuilder sb = new StringBuilder("{");
        for (Map.Entry<String, MemberShape> entry : struct.getAllMembers().entrySet()) {
            String name = entry.getKey();
            MemberShape member = entry.getValue();
            Shape target = model.expectShape(member.getTarget());
            boolean present = member.hasTrait(RequiredTrait.class)
                || member.hasTrait(DefaultTrait.class);
            sb.append("\n  ").append(name).append(present ? "" : "?")
              .append(": ").append(toTsType(target)).append(";");
        }
        sb.append("\n}");
        return sb.toString();
    }

    private String toTsType(Shape shape) {
        return switch (shape.getType()) {
            case STRING, ENUM -> "string";
            case INT_ENUM, INTEGER, LONG, FLOAT, DOUBLE -> "number";
            case BIG_INTEGER, BIG_DECIMAL -> "string";
            case BOOLEAN -> "boolean";
            case TIMESTAMP -> "string";
            case BLOB -> "string";
            case DOCUMENT -> "unknown";
            case STRUCTURE -> ZodEmitter.safeTypeName(shape.getId().getName());
            // restJson1 single-key union (CG-03): `{ A: T } | { B: T }`, inlined.
            case UNION -> unionTsType(shape.asUnionShape().get());
            case LIST -> {
                Shape memberTarget = model.expectShape(
                    shape.asListShape().get().getMember().getTarget());
                yield toTsType(memberTarget) + "[]";
            }
            case MAP -> {
                Shape valueTarget = model.expectShape(
                    shape.asMapShape().get().getValue().getTarget());
                yield "Record<string, " + toTsType(valueTarget) + ">";
            }
            default -> "unknown";
        };
    }

    /** restJson1 single-key union TS type: `{ A: T } | { B: T }` (CG-03). */
    private String unionTsType(UnionShape union) {
        if (union.getAllMembers().isEmpty()) return "never";
        List<String> variants = new ArrayList<>();
        for (Map.Entry<String, MemberShape> entry : union.getAllMembers().entrySet()) {
            Shape target = model.expectShape(entry.getValue().getTarget());
            variants.add("{ " + entry.getKey() + ": " + toTsType(target) + " }");
        }
        return String.join(" | ", variants);
    }
}
