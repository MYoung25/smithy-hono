package com.smithyhono.writers;

import com.smithyhono.ModelIndex;
import com.smithyhono.ModelIndex.CrudVerb;
import com.smithyhono.traits.PersistedTrait;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.HttpLabelTrait;
import software.amazon.smithy.model.traits.HttpPayloadTrait;
import software.amazon.smithy.model.traits.HttpPrefixHeadersTrait;
import software.amazon.smithy.model.traits.HttpQueryTrait;
import software.amazon.smithy.model.traits.HttpQueryParamsTrait;
import software.amazon.smithy.model.traits.HttpResponseCodeTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Emits {@code {group}.crud.gen.ts} — the default DB-backed CRUD implementation for a
 * {@code @persisted} resource (Plan 13, P3).
 *
 * <p>For each persisted resource the emitter writes a
 * {@code createDefault{Resource}Operations(store, hooks?)} factory that returns an object
 * satisfying the existing {@code {Resource}Operations} interface (only the lifecycle subset
 * create/put/read/update/delete/list the resource actually binds). Everything is
 * model-derived: the entity type, the output-wrapper member names, the paginated token /
 * page-size member names. The emitted {@code scopeFrom(c)} helper threads the principal's
 * owner/tenant id into the {@code DataScope} — only the keys the {@code @persisted} config
 * declares.
 *
 * <p>FALLBACK (rule #4): when an output structure isn't a plain single-member wrapper (or
 * carries {@code @httpResponseCode}/{@code @httpHeader} output members, which
 * {@code RouteEmitter.emitSuccessResponse} treats specially), the factory is skipped and a
 * build warning is logged — the resource is interface-only and the consumer writes it.
 */
public class CrudEmitter {

    private static final java.util.logging.Logger LOGGER =
        java.util.logging.Logger.getLogger(CrudEmitter.class.getName());

    /** The data-core package the emitted file imports the store + types from. */
    private static final String DATA_CORE_IMPORT = "@smithy-hono/data-core";

    private final Model model;
    private final ModelIndex index;
    private final String securityCoreImport;
    private final int fallbackDefaultPageSize;
    private final int fallbackMaxPageSize;
    private final boolean enforceResourceScoping;

    /**
     * Backwards-compatible convenience ctor: enforcement OFF (warn-only, the historical
     * behavior). Used by callers/tests that don't opt into strict resource scoping.
     */
    public CrudEmitter(Model model, ModelIndex index, String securityCoreImport,
                       int fallbackMaxPageSize, int fallbackDefaultPageSize) {
        this(model, index, securityCoreImport, fallbackMaxPageSize, fallbackDefaultPageSize, false);
    }

    public CrudEmitter(Model model, ModelIndex index, String securityCoreImport,
                       int fallbackMaxPageSize, int fallbackDefaultPageSize,
                       boolean enforceResourceScoping) {
        this.model = model;
        this.index = index;
        this.securityCoreImport = securityCoreImport;
        this.fallbackMaxPageSize = fallbackMaxPageSize;
        this.fallbackDefaultPageSize = fallbackDefaultPageSize;
        this.enforceResourceScoping = enforceResourceScoping;
    }

    /**
     * Emits {@code {group}.crud.gen.ts} for a persisted resource. The {@code groupName}
     * and {@code groupFileStem} must match the route file's grouping (resource name and its
     * kebab-cased stem), so the import {@code ./<stem>.gen} resolves. Returns the written
     * file name, or empty when the resource hit the fallback (no factory emitted).
     */
    public Optional<String> emit(ResourceShape resource, String groupName, String groupFileStem,
                                 FileManifest manifest) {
        return emit(resource, groupName, groupFileStem, java.util.Set.of(), java.util.Set.of(), manifest);
    }

    /** Convenience overload: no hoisted error classes (single-resource / test use). */
    public Optional<String> emit(ResourceShape resource, String groupName, String groupFileStem,
                                 Set<ShapeId> sharedShapeIds, FileManifest manifest) {
        return emit(resource, groupName, groupFileStem, sharedShapeIds, java.util.Set.of(), manifest);
    }

    /**
     * Emits {@code {group}.crud.gen.ts} for a persisted resource. {@code sharedShapeIds} is the
     * set of shapes the orchestrator hoisted into {@code shared.gen.ts} (referenced by 2+ resource
     * groups); when the entity {@code Data} type is among them the crud file imports it from
     * {@code ./shared.gen} (matching the router file's import), otherwise from {@code ./<stem>.gen}.
     * {@code sharedErrorIds} similarly routes error classes hoisted to {@code errors.gen.ts}.
     */
    public Optional<String> emit(ResourceShape resource, String groupName, String groupFileStem,
                                 Set<ShapeId> sharedShapeIds, Set<ShapeId> sharedErrorIds,
                                 FileManifest manifest) {
        Map<CrudVerb, OperationShape> ops = index.lifecycleOps(resource);
        if (ops.isEmpty()) return Optional.empty();

        Optional<Shape> entityOpt = index.entityShape(resource);
        if (entityOpt.isEmpty()) {
            warnFallback(resource, "its read op has no single-member output wrapper to derive the entity from");
            return Optional.empty();
        }

        // FALLBACK rule #4 — create/put/read/update outputs must be plain single-member
        // wrappers; no output may bind @httpResponseCode / @httpHeader (the route layer
        // treats those specially and the default impl can't reproduce them).
        for (CrudVerb verb : List.of(CrudVerb.CREATE, CrudVerb.PUT, CrudVerb.READ, CrudVerb.UPDATE)) {
            OperationShape op = ops.get(verb);
            if (op == null) continue;
            Optional<StructureShape> out = index.getOutput(op);
            if (out.isEmpty() || out.get().getAllMembers().isEmpty()) continue; // void output is fine
            if (!isPlainSingleWrapper(out.get())) {
                warnFallback(resource, op.getId().getName()
                    + "'s output is not a plain single-member wrapper (or binds @httpResponseCode/@httpHeader)");
                return Optional.empty();
            }
        }
        // The list output is a pagination wrapper (items + token), not single-member, so it
        // only fails on @httpResponseCode/@httpHeader output members.
        OperationShape listOp = ops.get(CrudVerb.LIST);
        if (listOp != null && index.getOutput(listOp).map(this::hasSpecialOutputMembers).orElse(false)) {
            warnFallback(resource, listOp.getId().getName()
                + "'s output binds @httpResponseCode/@httpHeader members");
            return Optional.empty();
        }

        Shape entity = entityOpt.get();
        String entityType = ZodEmitter.safeTypeName(entity.getId().getName());
        // The entity Data type is hoisted to shared.gen.ts when it's referenced by 2+ resource
        // groups (the router file imports it from there too); otherwise it lives in this group's
        // ./<stem>.gen. Import it from whichever module actually exports it so the two agree.
        String entityModule = sharedShapeIds.contains(entity.getId())
            ? "./shared.gen" : "./" + groupFileStem + ".gen";
        String interfaceName = groupName + "Operations";
        String factoryName = "createDefault" + groupName + "Operations";
        String hooksName = groupName + "Hooks";
        PersistedTrait config = index.persistedConfig(resource);

        // CODEGEN-EMIT-2-06 / AUTHZ-01 — surface the silent-insecure-by-default case: a
        // @persisted resource that declares NEITHER ownerField NOR tenantField runs every
        // generated CRUD op with an empty DataScope, so any authenticated caller can
        // read/update/delete any other caller's records (IDOR). Warn only when at least one
        // lifecycle op requires auth (an unauthenticated/public resource is legitimately
        // unscoped); genuinely single-tenant authenticated resources can silence this with a
        // resource policy (requireResourcePolicy) in the per-op middleware slot.
        warnIfUnscoped(resource, ops, config);

        // The single string identifier (validated upstream) — the store key + the input
        // member bound by @httpLabel on read/update/delete.
        String idMember = index.identifierMembers(resource).get(0);

        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        writer.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
        writer.blank();

        emitImports(writer, ops, entityType, entityModule, interfaceName, groupFileStem,
            config.isOptimisticConcurrency(), sharedErrorIds);
        emitHooksInterface(writer, hooksName, ops);
        emitScopeFrom(writer, config);
        emitFactory(writer, resource, ops, entity, entityType, interfaceName, factoryName, hooksName, config, idMember);

        String fileName = groupFileStem + ".crud.gen.ts";
        writer.write(manifest, fileName);
        return Optional.of(fileName);
    }

    // ── Imports ────────────────────────────────────────────────────────────────

    private void emitImports(TypeScriptFileWriter writer, Map<CrudVerb, OperationShape> ops,
                             String entityType, String entityModule, String interfaceName,
                             String groupFileStem, boolean optimisticConcurrency,
                             Set<ShapeId> sharedErrorIds) {
        writer.line("import type { DataStore, DataScope } from '" + DATA_CORE_IMPORT + "'");
        // OptimisticConflictError is only referenced by the update conflict try/catch, which
        // is emitted only when the resource declares optimisticConcurrency.
        if (optimisticConcurrency) {
            writer.line("import { OptimisticConflictError } from '" + DATA_CORE_IMPORT + "'");
        }

        // Type imports: the entity Data type comes from whichever module exports it (the router's
        // ./<stem>.gen, or ./shared.gen when hoisted because 2+ groups reference it). The
        // operations interface always lives in this group's ./<stem>.gen. The factory returns
        // plain object literals, so the output-wrapper types are never referenced / imported.
        String routeModule = "./" + groupFileStem + ".gen";
        if (entityModule.equals(routeModule)) {
            writer.line("import type { " + entityType + ", " + interfaceName + " } from '"
                + routeModule + "'");
        } else {
            writer.line("import type { " + entityType + " } from '" + entityModule + "'");
            writer.line("import type { " + interfaceName + " } from '" + routeModule + "'");
        }

        // Error classes the factory throws (404 not-found, 409 conflict) are imported from
        // wherever they're emitted: ./errors.gen when hoisted (shared by 2+ groups), else this
        // group's ./<stem>.gen — matching the router/client emission.
        Set<String> localErrorImports = new LinkedHashSet<>();
        Set<String> sharedErrorImports = new LinkedHashSet<>();
        for (StructureShape err : boundErrorShapes(ops)) {
            if (sharedErrorIds.contains(err.getId())) sharedErrorImports.add(err.getId().getName());
            else localErrorImports.add(err.getId().getName());
        }
        if (!localErrorImports.isEmpty()) {
            writer.line("import { " + String.join(", ", localErrorImports)
                + " } from './" + groupFileStem + ".gen'");
        }
        if (!sharedErrorImports.isEmpty()) {
            writer.line("import { " + String.join(", ", sharedErrorImports) + " } from './errors.gen'");
        }

        writer.line("import type { Context } from 'hono'");
        writer.line("import type { SecurityEnv } from '" + securityCoreImport + "'");
        writer.blank();
    }

    // ── Hooks interface ──────────────────────────────────────────────────────────

    private void emitHooksInterface(TypeScriptFileWriter writer, String hooksName,
                                    Map<CrudVerb, OperationShape> ops) {
        writer.comment("---- Hooks ----");
        writer.blank();
        writer.line("export interface " + hooksName + " {");
        if (ops.containsKey(CrudVerb.CREATE) || ops.containsKey(CrudVerb.PUT)) {
            writer.line("  beforeCreate?(value: unknown, principal: unknown): void | Promise<void>");
        }
        if (ops.containsKey(CrudVerb.READ)) {
            writer.line("  afterRead?(value: unknown, principal: unknown): void | Promise<void>");
        }
        if (ops.containsKey(CrudVerb.UPDATE)) {
            writer.line("  beforeUpdate?(value: unknown, principal: unknown): void | Promise<void>");
        }
        if (ops.containsKey(CrudVerb.DELETE)) {
            writer.line("  beforeDelete?(id: string, principal: unknown): void | Promise<void>");
        }
        if (ops.containsKey(CrudVerb.LIST)) {
            writer.line("  filterList?(items: unknown[], principal: unknown): unknown[] | Promise<unknown[]>");
        }
        writer.line("}");
        writer.blank();
    }

    // ── scopeFrom ────────────────────────────────────────────────────────────────

    private void emitScopeFrom(TypeScriptFileWriter writer, PersistedTrait config) {
        List<String> keys = new ArrayList<>();
        // Only emit the scope keys the @persisted config actually declares; otherwise
        // scopeFrom returns {} and the store ignores scope.
        // p is asserted present below (fail-closed), so the keys read it directly.
        config.getOwnerField().ifPresent(f -> keys.add("ownerId: p.id"));
        config.getTenantField().ifPresent(f -> keys.add("tenantId: p.tenantId"));

        writer.line("function scopeFrom(c?: Context<SecurityEnv>): DataScope {");
        if (keys.isEmpty()) {
            writer.line("  return {}");
        } else {
            // Owner/tenant scoping is declared, so this resource is meant to run behind
            // @requiresAuth with a principal in context. Fail closed if the principal is
            // missing (auth middleware misconfiguration) rather than silently collapsing
            // every record into a single empty-owner/tenant partition (CODEGEN-EMIT-2-07).
            writer.line("  const p = c?.get('principal')");
            writer.line("  if (!p) throw new Error('scopeFrom: missing authenticated principal — this resource declares owner/tenant scoping and must be mounted behind @requiresAuth')");
            writer.line("  return { " + String.join(", ", keys) + " }");
        }
        writer.line("}");
        writer.blank();
    }

    // ── Factory ──────────────────────────────────────────────────────────────────

    private void emitFactory(TypeScriptFileWriter writer, ResourceShape resource,
                             Map<CrudVerb, OperationShape> ops, Shape entity, String entityType,
                             String interfaceName, String factoryName, String hooksName,
                             PersistedTrait config, String idMember) {
        boolean timestamps = config.isTimestamps();
        boolean hasCreatedAt = timestamps && entityHasMember(entity, "createdAt");
        boolean hasUpdatedAt = timestamps && entityHasMember(entity, "updatedAt");
        boolean oc = config.isOptimisticConcurrency();
        String notFound = notFoundError(ops).orElse(null);
        String conflict = conflictError(ops).orElse(null);

        writer.comment("---- Default operations factory ----");
        writer.blank();
        emitFactoryJsDoc(writer, factoryName, config);
        writer.line("export function " + factoryName + "(");
        writer.line("  store: DataStore<" + entityType + ">, hooks?: " + hooksName + ",");
        writer.line("): " + interfaceName + " {");
        writer.line("  return {");

        // create — server-assigned id (crypto.randomUUID()).
        if (ops.containsKey(CrudVerb.CREATE)) {
            emitCreateLike(writer, ops.get(CrudVerb.CREATE), entity, idMember,
                hasCreatedAt, hasUpdatedAt, true);
        }
        // put — client-supplied id from the @httpLabel; unconditional upsert.
        if (ops.containsKey(CrudVerb.PUT)) {
            emitCreateLike(writer, ops.get(CrudVerb.PUT), entity, idMember,
                hasCreatedAt, hasUpdatedAt, false);
        }
        if (ops.containsKey(CrudVerb.READ)) {
            emitRead(writer, ops.get(CrudVerb.READ), idMember, notFound);
        }
        if (ops.containsKey(CrudVerb.UPDATE)) {
            emitUpdate(writer, ops.get(CrudVerb.UPDATE), idMember, hasUpdatedAt, notFound, conflict, oc);
        }
        if (ops.containsKey(CrudVerb.DELETE)) {
            emitDelete(writer, ops.get(CrudVerb.DELETE), idMember, notFound);
        }
        if (ops.containsKey(CrudVerb.LIST)) {
            emitList(writer, ops.get(CrudVerb.LIST), config);
        }

        writer.line("  }");
        writer.line("}");
        writer.blank();
    }

    /**
     * Emits the JSDoc block above the factory. The {@code @persisted} config is otherwise
     * decorative here — soft-delete, the table/collection name, and the declared indexes are
     * store-construction concerns this factory does not (deliberately) configure. The doc makes
     * the trait non-silent: it restates the resolved config and tells the consumer to build their
     * DataStore with matching options, so the two sources of truth can't silently diverge.
     */
    private void emitFactoryJsDoc(TypeScriptFileWriter writer, String factoryName, PersistedTrait config) {
        // The resource name = factoryName without the createDefault.../...Operations affixes.
        String resource = factoryName.substring("createDefault".length(),
            factoryName.length() - "Operations".length());

        // Only restate non-default / declared config — defaulted/empty values add noise.
        List<String> modeled = new ArrayList<>();
        List<String> storeOpts = new ArrayList<>();
        if (config.isSoftDelete()) {
            modeled.add("softDelete: true");
            storeOpts.add("softDelete: true");
        }
        config.getTable().ifPresent(t -> {
            modeled.add("table: \"" + t + "\"");
            storeOpts.add("table: \"" + t + "\"");
        });
        // timestamps defaults to true, so only mention it when explicitly disabled.
        if (!config.isTimestamps()) {
            modeled.add("timestamps: false");
        }
        if (config.isOptimisticConcurrency()) {
            modeled.add("optimisticConcurrency: true");
            storeOpts.add("optimisticConcurrency: true");
        }
        if (!config.getIndexes().isEmpty()) {
            List<String> indexKeys = new ArrayList<>();
            for (PersistedTrait.Index ix : config.getIndexes()) {
                indexKeys.add(ix.getKey());
            }
            modeled.add("indexes: [" + String.join(", ", indexKeys) + "]");
            storeOpts.add("indexes: ["
                + indexKeys.stream().map(k -> "\"" + k + "\"").collect(java.util.stream.Collectors.joining(", "))
                + "]");
        }

        writer.line("/**");
        writer.line(" * Default CRUD operations for " + resource + ", backed by a DataStore.");
        writer.line(" *");
        boolean unscoped = config.getOwnerField().isEmpty() && config.getTenantField().isEmpty();
        if (modeled.isEmpty()) {
            // Bare @persisted — all defaults. Nothing for the consumer to mirror on the store.
            writer.line(" * This resource is modeled with a bare `@persisted` (all defaults), so the");
            writer.line(" * store needs no special construction options to honor the model intent.");
        } else {
            writer.line(" * This resource is modeled `@persisted(" + String.join(", ", modeled) + ")`.");
            writer.line(" * Construct your DataStore with matching options so the model intent is");
            writer.line(" * honored, e.g. with your chosen adapter's createXDataStore:");
            writer.line(" *   createXDataStore(..., { " + String.join(", ", storeOpts) + " })");
            writer.line(" * Soft-delete, table/collection name, and declared indexes are");
            writer.line(" * store-construction concerns — this factory does not configure the store.");
        }
        // CODEGEN-EMIT-2-06 / AUTHZ-01 — make the lack of isolation non-silent in the
        // generated artifact, not just in the build log.
        if (unscoped) {
            writer.line(" *");
            writer.line(" * NO owner/tenant isolation: this resource declares neither `ownerField` nor");
            writer.line(" * `tenantField`, so every operation runs with an empty DataScope and every");
            writer.line(" * authenticated caller can read/update/delete every record (IDOR). Add");
            writer.line(" * `ownerField`/`tenantField` to `@persisted`, or guard the id-addressed ops");
            writer.line(" * with `requireResourcePolicy(isOwner()/sameTenant())`, unless the resource is");
            writer.line(" * intentionally single-tenant/public.");
        }
        writer.line(" */");
    }

    /** create / put — both build a fresh entity and call store.create / store.put. */
    private void emitCreateLike(TypeScriptFileWriter writer, OperationShape op, Shape entity,
                                String idMember, boolean hasCreatedAt, boolean hasUpdatedAt,
                                boolean serverId) {
        String opName = op.getId().getName();
        String bodyMember = bodySpreadMember(op);
        String wrapper = soleOutputMember(op).orElse("item");

        writer.line("    async " + opName + "(input, c) {");
        writer.line("      const scope = scopeFrom(c)");
        if (hasCreatedAt || hasUpdatedAt) {
            writer.line("      const now = new Date().toISOString()");
        }
        // The id is either server-assigned (create) or the client-supplied @httpLabel (put).
        if (serverId) {
            writer.line("      const id = crypto.randomUUID()");
        } else {
            writer.line("      const id = input." + idMember);
        }
        // The persisted body: only the implicit-body members (or the @httpPayload member),
        // never the transport-only @httpLabel/@httpQuery/@httpHeader bindings.
        String bodySpread = emitBodyDestructure(writer, op, bodyMember);
        StringBuilder entityExpr = new StringBuilder("      const entity = { ");
        entityExpr.append(bodySpread);
        entityExpr.append(", ").append(idMember).append(": id");
        if (hasCreatedAt) entityExpr.append(", createdAt: now");
        if (hasUpdatedAt) entityExpr.append(", updatedAt: now");
        entityExpr.append(", ...scope } as ").append(entityType(entity));
        writer.line(entityExpr.toString());
        writer.line("      await hooks?.beforeCreate?.(entity, c?.get('principal'))");
        writer.line("      const saved = await store." + (serverId ? "create" : "put")
            + "(id, entity, scope)");
        writer.line("      return { " + wrapper + ": saved }");
        writer.line("    },");
    }

    private void emitRead(TypeScriptFileWriter writer, OperationShape op, String idMember, String notFound) {
        String opName = op.getId().getName();
        String wrapper = soleOutputMember(op).orElse("item");
        writer.line("    async " + opName + "(input, c) {");
        writer.line("      const " + wrapper + " = await store.get(input." + idMember + ", scopeFrom(c))");
        writer.line("      if (!" + wrapper + ") throw new " + notFound + "(`not found: ${input." + idMember + "}`)");
        writer.line("      await hooks?.afterRead?.(" + wrapper + ", c?.get('principal'))");
        writer.line("      return { " + wrapper + " }");
        writer.line("    },");
    }

    private void emitUpdate(TypeScriptFileWriter writer, OperationShape op, String idMember,
                            boolean hasUpdatedAt, String notFound, String conflict, boolean oc) {
        String opName = op.getId().getName();
        String bodyMember = bodySpreadMember(op);
        String wrapper = soleOutputMember(op).orElse("item");
        writer.line("    async " + opName + "(input, c) {");
        writer.line("      const scope = scopeFrom(c)");
        writer.line("      const existing = await store.get(input." + idMember + ", scope)");
        writer.line("      if (!existing) throw new " + notFound + "(`not found: ${input." + idMember + "}`)");
        // Only the implicit-body members (or the @httpPayload member) are merged in; the
        // transport-only @httpLabel/@httpQuery/@httpHeader bindings are not persisted.
        String bodySpread = emitBodyDestructure(writer, op, bodyMember);
        StringBuilder merged = new StringBuilder("      const merged = { ...existing, ");
        merged.append(bodySpread);
        merged.append(", ").append(idMember).append(": input.").append(idMember);
        if (hasUpdatedAt) merged.append(", updatedAt: new Date().toISOString()");
        merged.append(" }");
        writer.line(merged.toString());
        writer.line("      await hooks?.beforeUpdate?.(merged, c?.get('principal'))");
        if (oc && conflict != null) {
            // optimisticConcurrency: rethrow the port's conflict as the modeled 409, else
            // the router's catch maps it to a silent 500.
            writer.line("      try {");
            writer.line("        const saved = await store.update(input." + idMember
                + ", merged, existing.version, scope)");
            writer.line("        return { " + wrapper + ": saved }");
            writer.line("      } catch (e) {");
            writer.line("        if (e instanceof OptimisticConflictError)");
            writer.line("          throw new " + conflict + "(`conflict: ${input." + idMember + "}`)");
            writer.line("        throw e");
            writer.line("      }");
        } else {
            writer.line("      const saved = await store.update(input." + idMember
                + ", merged, undefined, scope)");
            writer.line("      return { " + wrapper + ": saved }");
        }
        writer.line("    },");
    }

    private void emitDelete(TypeScriptFileWriter writer, OperationShape op, String idMember, String notFound) {
        String opName = op.getId().getName();
        writer.line("    async " + opName + "(input, c) {");
        writer.line("      await hooks?.beforeDelete?.(input." + idMember + ", c?.get('principal'))");
        writer.line("      const existed = await store.delete(input." + idMember + ", undefined, scopeFrom(c))");
        writer.line("      if (!existed) throw new " + notFound + "(`not found: ${input." + idMember + "}`)");
        writer.line("    },");
    }

    private void emitList(TypeScriptFileWriter writer, OperationShape op, PersistedTrait config) {
        String opName = op.getId().getName();
        PaginationMembers pm = paginationMembers(op);
        // Declared @persisted index keys that a list @httpQuery input member matches drive an
        // equality `filter` on store.list (the DataStore honors query.filter). Only keys whose
        // input value is actually supplied are included, so an absent param doesn't over-filter.
        List<String> filterKeys = listFilterKeys(op, config);

        writer.line("    async " + opName + "(input, c) {");
        if (!filterKeys.isEmpty()) {
            writer.line("      const filter: Record<string, string | number | boolean> = {}");
            for (String key : filterKeys) {
                writer.line("      if (input." + key + " !== undefined) filter." + key + " = input." + key);
            }
        }
        // RATE-06 — clamp the requested page size to the resolved max so a client cannot
        // ask the store for an unbounded number of rows. When the @paginated page-size
        // member has no @range(max:), paginationFor falls back to the configured max.
        int maxPageSize = index.paginationFor(op, fallbackMaxPageSize, fallbackDefaultPageSize)
            .map(p -> p.maxPageSize).orElse(fallbackMaxPageSize);
        String limitExpr = "Math.min(input." + pm.pageSizeMember + " ?? " + fallbackDefaultPageSize
            + ", " + maxPageSize + ")";
        writer.line("      const page = await store.list(");
        if (filterKeys.isEmpty()) {
            writer.line("        { cursor: input." + pm.tokenMember + ", limit: " + limitExpr + " },");
        } else {
            writer.line("        { cursor: input." + pm.tokenMember + ", limit: " + limitExpr + ", filter },");
        }
        writer.line("        scopeFrom(c),");
        writer.line("      )");
        writer.line("      let items = page.items");
        writer.line("      if (hooks?.filterList) items = (await hooks.filterList(items, c?.get('principal'))) as typeof items");
        writer.line("      return { " + pm.itemsMember + ": items, " + pm.tokenMember + ": page.cursor }");
        writer.line("    },");
    }

    /**
     * The declared {@code @persisted} index keys for which the list op has a matching
     * {@code @httpQuery} input member (by member name). These become equality {@code filter}
     * entries on {@code store.list}. Empty when no indexes are declared or none match — so a
     * resource without indexes / matching params keeps the unfiltered list behavior.
     */
    private List<String> listFilterKeys(OperationShape op, PersistedTrait config) {
        if (config.getIndexes().isEmpty()) return List.of();

        Set<String> indexKeys = new LinkedHashSet<>();
        for (PersistedTrait.Index ix : config.getIndexes()) indexKeys.add(ix.getKey());

        List<String> matched = new ArrayList<>();
        index.getInput(op).ifPresent(in -> {
            for (Map.Entry<String, MemberShape> e : in.getAllMembers().entrySet()) {
                if (e.getValue().hasTrait(HttpQueryTrait.class) && indexKeys.contains(e.getKey())) {
                    matched.add(e.getKey());
                }
            }
        });
        return matched;
    }

    // ── Derivation helpers ──────────────────────────────────────────────────────

    /** The sole member name of the op's output structure (read/update/create wrapper). */
    private Optional<String> soleOutputMember(OperationShape op) {
        return index.getOutput(op)
            .filter(out -> out.getAllMembers().size() == 1)
            .map(out -> out.getAllMembers().keySet().iterator().next());
    }

    /**
     * The {@code @httpPayload} member of the op's input, when present — the create/update
     * body arrives under that single member. When there is no payload member, the input is
     * spread directly (its members already carry the body fields).
     */
    private String bodySpreadMember(OperationShape op) {
        return index.getInput(op)
            .map(in -> {
                for (Map.Entry<String, MemberShape> e : in.getAllMembers().entrySet()) {
                    if (e.getValue().hasTrait(HttpPayloadTrait.class)) {
                        return e.getKey();
                    }
                }
                return null;
            })
            .orElse(null);
    }

    /**
     * Emits the destructuring (if any) needed to isolate the persisted body of a create/put/
     * update op, and returns the spread expression to splice into the entity literal.
     *
     * <ul>
     *   <li>{@code @httpPayload} member → the body is that single member: spread {@code
     *       ...input.<payload>} directly (no destructure needed).</li>
     *   <li>no {@code @httpPayload} → the body is the implicit-body members only; the
     *       transport-only {@code @httpLabel}/{@code @httpQuery}/{@code @httpHeader} (and the
     *       catch-all {@code @httpQueryParams}/{@code @httpPrefixHeaders}) bindings must NOT be
     *       persisted. When such members exist, emit {@code const { <transport>, ...body } =
     *       input} and spread {@code ...body}; otherwise spread {@code ...input} directly.</li>
     * </ul>
     */
    private String emitBodyDestructure(TypeScriptFileWriter writer, OperationShape op, String bodyMember) {
        if (bodyMember != null) {
            return "...input." + bodyMember;
        }
        List<String> nonBody = nonBodyMembers(op);
        if (nonBody.isEmpty()) {
            return "...input";
        }
        writer.line("      const { " + String.join(", ", nonBody) + ", ...body } = input");
        return "...body";
    }

    /**
     * Input member names bound to transport (path/query/header and the catch-all query-params
     * / prefix-headers) rather than the implicit request body — i.e. the members that must be
     * stripped before persisting when the op has no {@code @httpPayload} member.
     */
    private List<String> nonBodyMembers(OperationShape op) {
        List<String> names = new ArrayList<>();
        index.getInput(op).ifPresent(in -> {
            for (Map.Entry<String, MemberShape> e : in.getAllMembers().entrySet()) {
                MemberShape m = e.getValue();
                if (m.hasTrait(HttpLabelTrait.class)
                        || m.hasTrait(HttpQueryTrait.class)
                        || m.hasTrait(HttpHeaderTrait.class)
                        || m.hasTrait(HttpQueryParamsTrait.class)
                        || m.hasTrait(HttpPrefixHeadersTrait.class)) {
                    names.add(e.getKey());
                }
            }
        });
        return names;
    }

    /** True when the entity declares a member with the given name (e.g. createdAt). */
    private boolean entityHasMember(Shape entity, String name) {
        return entity.asStructureShape()
            .map(s -> s.getAllMembers().containsKey(name))
            .orElse(false);
    }

    private String entityType(Shape entity) {
        return ZodEmitter.safeTypeName(entity.getId().getName());
    }

    /**
     * True when the structure is a plain single-member wrapper: exactly one member, and no
     * member binds {@code @httpResponseCode} / {@code @httpHeader} (which the route layer
     * treats specially and the default impl can't reproduce).
     */
    private boolean isPlainSingleWrapper(StructureShape out) {
        return out.getAllMembers().size() == 1 && !hasSpecialOutputMembers(out);
    }

    /** True when any output member binds {@code @httpResponseCode} / {@code @httpHeader}. */
    private boolean hasSpecialOutputMembers(StructureShape out) {
        for (MemberShape m : out.getAllMembers().values()) {
            if (m.hasTrait(HttpResponseCodeTrait.class) || m.hasTrait(HttpHeaderTrait.class)) {
                return true;
            }
        }
        return false;
    }

    /** The bound 404 error class name (read/update/delete throw it on miss). */
    private Optional<String> notFoundError(Map<CrudVerb, OperationShape> ops) {
        return boundErrorWithStatus(ops, 404);
    }

    /** The bound 409 error class name, used when optimisticConcurrency is on. */
    private Optional<String> conflictError(Map<CrudVerb, OperationShape> ops) {
        return boundErrorWithStatus(ops, 409);
    }

    /** The bound error SHAPES the factory imports (404 not-found + 409 conflict), deduped. */
    private List<StructureShape> boundErrorShapes(Map<CrudVerb, OperationShape> ops) {
        java.util.LinkedHashMap<ShapeId, StructureShape> seen = new java.util.LinkedHashMap<>();
        for (int status : new int[] {404, 409}) {
            for (OperationShape op : ops.values()) {
                for (StructureShape err : index.getAllErrors(op)) {
                    if (err.getTrait(HttpErrorTrait.class).map(HttpErrorTrait::getCode).orElse(-1) == status) {
                        seen.putIfAbsent(err.getId(), err);
                    }
                }
            }
        }
        return new ArrayList<>(seen.values());
    }

    private Optional<String> boundErrorWithStatus(Map<CrudVerb, OperationShape> ops, int status) {
        for (OperationShape op : ops.values()) {
            for (StructureShape err : index.getAllErrors(op)) {
                if (err.getTrait(HttpErrorTrait.class).map(HttpErrorTrait::getCode).orElse(-1) == status) {
                    return Optional.of(err.getId().getName());
                }
            }
        }
        return Optional.empty();
    }

    /** Resolved {@code @paginated} member names for the list op's input. */
    private PaginationMembers paginationMembers(OperationShape op) {
        software.amazon.smithy.model.traits.PaginatedTrait opTrait =
            op.getTrait(software.amazon.smithy.model.traits.PaginatedTrait.class).orElse(null);
        software.amazon.smithy.model.traits.PaginatedTrait svcTrait =
            index.getService().getTrait(software.amazon.smithy.model.traits.PaginatedTrait.class).orElse(null);
        String items = resolvePaginated(opTrait, svcTrait, t -> t.getItems(), "items");
        String token = resolvePaginated(opTrait, svcTrait, t -> t.getInputToken(), "nextToken");
        String pageSize = resolvePaginated(opTrait, svcTrait, t -> t.getPageSize(), "maxResults");
        return new PaginationMembers(items, token, pageSize);
    }

    private String resolvePaginated(
            software.amazon.smithy.model.traits.PaginatedTrait opTrait,
            software.amazon.smithy.model.traits.PaginatedTrait svcTrait,
            java.util.function.Function<software.amazon.smithy.model.traits.PaginatedTrait,
                Optional<String>> getter,
            String fallback) {
        if (opTrait != null) {
            Optional<String> v = getter.apply(opTrait);
            if (v.isPresent()) return v.get();
        }
        if (svcTrait != null) {
            Optional<String> v = getter.apply(svcTrait);
            if (v.isPresent()) return v.get();
        }
        return fallback;
    }

    /**
     * Emits a build-time DANGER warning when a {@code @persisted} resource declares no
     * isolation key ({@code ownerField}/{@code tenantField}) yet at least one lifecycle op
     * requires an authenticated principal. Such a resource generates an IDOR-capable CRUD
     * layer (empty {@code DataScope} → all principals share one partition) with, otherwise,
     * no signal (CODEGEN-EMIT-2-06 / AUTHZ-01). Genuinely single-tenant or public resources
     * are left untouched: declaring an isolation key, or having no authenticated op,
     * suppresses the warning.
     */
    private void warnIfUnscoped(ResourceShape resource, Map<CrudVerb, OperationShape> ops,
                                PersistedTrait config) {
        if (config.getOwnerField().isPresent() || config.getTenantField().isPresent()) return;
        // Explicit, auditable opt-out: the resource is intentionally single-tenant/public.
        if (config.isAllowUnscoped()) return;
        boolean anyAuthenticated = ops.values().stream().anyMatch(this::requiresAuth);
        if (!anyAuthenticated) return;
        // Opt-in strict enforcement: fail the build rather than emit an IDOR-capable CRUD layer.
        if (enforceResourceScoping) {
            throw new software.amazon.smithy.codegen.core.CodegenException(String.format(
                "enforceResourceScoping is ON and @persisted resource %s declares neither "
                + "ownerField nor tenantField but has authenticated lifecycle ops — its generated "
                + "CRUD would run with an empty DataScope and provide NO owner/tenant isolation "
                + "(IDOR). Add ownerField/tenantField to @persisted, or — if this resource is "
                + "intentionally single-tenant/public — set allowUnscoped: true on @persisted to "
                + "opt out explicitly.",
                resource.getId().getName()));
        }
        LOGGER.warning(String.format(
            "DANGER: @persisted resource %s declares neither ownerField nor tenantField but "
            + "has authenticated lifecycle ops — its generated CRUD runs with an empty DataScope "
            + "and provides NO owner/tenant isolation: every authenticated caller can read/update/"
            + "delete every record (IDOR). Add ownerField/tenantField to @persisted, or guard the "
            + "id-addressed ops with requireResourcePolicy(isOwner()/sameTenant()) in the per-op "
            + "middleware slot. Suppress intentionally by confirming the resource is single-tenant/public.",
            resource.getId().getName()));
    }

    /**
     * True when the op carries a non-anonymous auth scheme (i.e. an authenticated principal
     * must reach the handler). Mirrors {@code RouteEmitter.needsAuthorize}'s scheme check.
     */
    private boolean requiresAuth(OperationShape op) {
        return index.authSchemesFor(op).stream().anyMatch(s -> !s.equals("anonymous"));
    }

    private void warnFallback(ResourceShape resource, String reason) {
        LOGGER.warning(String.format(
            "Plan 13: skipping default CRUD impl for @persisted resource %s — %s. "
            + "The resource is interface-only; implement %sOperations by hand.",
            resource.getId().getName(), reason, resource.getId().getName()));
    }

    /** The resolved input member names for a paginated list op. */
    private static final class PaginationMembers {
        final String itemsMember;
        final String tokenMember;
        final String pageSizeMember;

        PaginationMembers(String itemsMember, String tokenMember, String pageSizeMember) {
            this.itemsMember = itemsMember;
            this.tokenMember = tokenMember;
            this.pageSizeMember = pageSizeMember;
        }
    }
}
