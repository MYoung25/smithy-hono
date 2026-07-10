package com.smithyhono.writers;

import com.smithyhono.ModelIndex;
import com.smithyhono.ModelIndex.CrudVerb;
import com.smithyhono.traits.LiveTrait;
import com.smithyhono.traits.PersistedTrait;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpErrorTrait;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Emits {@code {group}.live.gen.ts} — a FUNCTIONAL realtime SSE subscribe router + the
 * notify-on-commit wiring for a {@code @live} resource (Phase L1/L2).
 *
 * <p>Supersedes the non-functional {@code events.template.ts} for keyed resources: instead of
 * handing the consumer a "write your own bus" template, this emits a real
 * {@code create{Resource}LiveRouter(hub, store)} that mounts {@code GET /<resource>/:id/events},
 * resolves the channel key, applies the SAME op-tier {@code authorize()} the resource's read op
 * uses (Phase L2 — subscribing is gated exactly like reading), enforces the SAME resource-tier
 * owner/tenant scope the read op enforces (Phase L2 — a caller who would 404 on the read cannot
 * subscribe to the channel), and bridges the request to the {@code @smithy-hono/realtime}
 * {@code liveEventStream(c, hub, channelId, eventTypes)} helper.
 *
 * <p><b>Resource-tier entitlement (the IDOR fix).</b> The op-tier {@code authorize()} only checks
 * the read PERMISSION; it cannot carry the request principal into the app-singleton hub. So a
 * caller holding the read permission but scoped OUT of a row (different owner/tenant) would still
 * be able to subscribe to that row's channel and observe its version-advances (and, with
 * {@code pushRecords}, its bodies) — even though the read op returns 404. To close this the router
 * mirrors {@code CrudEmitter.emitRead}: when the {@code @persisted} resource declares
 * {@code ownerField}/{@code tenantField}, the router does
 * {@code const existing = await store.get(id, scopeFrom(c))} and throws the resource's bound 404
 * NotFound when null BEFORE calling {@code liveEventStream}. Existence is not leaked and
 * cross-owner/tenant subscribe fails closed (404), consistent with the read op.
 *
 * <p>The Durable Object backend is a STOCK generic export in {@code @smithy-hono/adapter-cf}
 * ({@code RealtimeDurableObject}), NOT a per-resource generated class — so this emitter emits
 * only the router + the notify wiring, never a DO class.
 *
 * <p>Notify-on-commit is a store DECORATOR ({@code withLiveNotify(store, hub, opts)}), not a
 * change to the CRUD factory — so {@code CrudEmitter} is untouched. The one-line composition
 * wiring is shown as a README comment at the foot of the file. Note the router takes the RAW
 * scoped store (for the entitlement check), while the ops factory takes the notify-decorated one.
 */
public class LiveEmitter {

    private static final java.util.logging.Logger LOGGER =
        java.util.logging.Logger.getLogger(LiveEmitter.class.getName());

    /** The opt-in runtime package the generated realtime code imports from. */
    static final String REALTIME_IMPORT = "@smithy-hono/realtime";

    /** The data-core package the entitlement guard imports the store + scope types from. */
    private static final String DATA_CORE_IMPORT = "@smithy-hono/data-core";

    private final Model model;
    private final ModelIndex index;
    private final RouteEmitter routeEmitter;
    private final String securityCoreImport;
    private final boolean enforceResourceScoping;

    /** Backwards-compatible ctor: warn-only (no strict enforcement). */
    public LiveEmitter(Model model, ModelIndex index, RouteEmitter routeEmitter,
                       String securityCoreImport) {
        this(model, index, routeEmitter, securityCoreImport, false);
    }

    public LiveEmitter(Model model, ModelIndex index, RouteEmitter routeEmitter,
                       String securityCoreImport, boolean enforceResourceScoping) {
        this.model = model;
        this.index = index;
        this.routeEmitter = routeEmitter;
        this.securityCoreImport = securityCoreImport;
        this.enforceResourceScoping = enforceResourceScoping;
    }

    // ── Static conventions (shared with MetadataRegistryEmitter) ───────────────

    /** The lowercased resource name — the PINNED channel + route prefix convention. */
    public static String lowerResource(ResourceShape resource) {
        return resource.getId().getName().toLowerCase(java.util.Locale.ROOT);
    }

    /** The channel-key member: {@code @live.keyMember}, defaulted to the resource identifier. */
    public static String keyMember(ResourceShape resource, LiveTrait cfg, ModelIndex index) {
        return cfg.getKeyMember()
            .filter(m -> !m.isEmpty())
            .orElseGet(() -> {
                List<String> ids = index.identifierMembers(resource);
                return ids.isEmpty() ? "id" : ids.get(0);
            });
    }

    /** The subscribe route path: {@code /<lowercasedResource>/:<keyMember>/events}. */
    public static String liveRoutePath(ResourceShape resource, LiveTrait cfg, ModelIndex index) {
        return "/" + lowerResource(resource) + "/:" + keyMember(resource, cfg, index) + "/events";
    }

    /** Synthetic registry operation name for the resource's live subscribe endpoint. */
    public static String liveOpName(ResourceShape resource) {
        return resource.getId().getName() + "LiveSubscribe";
    }

    /** The default event {@code type}: {@code "<lowercasedResource>:updated"}. */
    public static String defaultEventType(ResourceShape resource) {
        return lowerResource(resource) + ":updated";
    }

    /**
     * The event {@code type} strings the endpoint forwards to subscribers: the resolved
     * {@code eventType} (default {@code "<resource>:updated"}) plus created/deleted when
     * {@code lifecycleEvents} is set.
     */
    public static List<String> eventTypes(ResourceShape resource, LiveTrait cfg) {
        String base = cfg.getEventType().filter(t -> !t.isEmpty()).orElse(defaultEventType(resource));
        List<String> types = new ArrayList<>();
        types.add(base);
        if (cfg.isLifecycleEvents()) {
            types.add(lowerResource(resource) + ":created");
            types.add(lowerResource(resource) + ":deleted");
        }
        return types;
    }

    // ── Emit ────────────────────────────────────────────────────────────────────

    /** Convenience overload (single-resource / test use): no hoisted shapes/errors. */
    public Optional<String> emit(ResourceShape resource, String groupName, String groupFileStem,
                                 FileManifest manifest) {
        return emit(resource, groupName, groupFileStem, Set.of(), Set.of(), manifest);
    }

    /**
     * Emits {@code {groupFileStem}.live.gen.ts} for a {@code @live} resource. {@code groupName}
     * / {@code groupFileStem} mirror the route/crud file grouping (resource name + kebab stem),
     * so the {@code ./registry.gen} import resolves. {@code sharedShapeIds}/{@code sharedErrorIds}
     * route the entity Data type + the bound NotFound error to {@code ./shared.gen}/{@code
     * ./errors.gen} when hoisted (matching the router/crud file imports). Returns the written
     * file name.
     */
    public Optional<String> emit(ResourceShape resource, String groupName, String groupFileStem,
                                 Set<ShapeId> sharedShapeIds, Set<ShapeId> sharedErrorIds,
                                 FileManifest manifest) {
        LiveTrait cfg = index.liveConfig(resource);
        PersistedTrait persisted = index.persistedConfig(resource);
        String lower = lowerResource(resource);
        String key = keyMember(resource, cfg, index);
        String routePath = liveRoutePath(resource, cfg, index);
        List<String> eventTypes = eventTypes(resource, cfg);
        String eventTypesConst = groupName.toUpperCase(java.util.Locale.ROOT) + "_LIVE_EVENT_TYPES";
        String routerFn = "create" + groupName + "LiveRouter";
        String eventType = cfg.getEventType().filter(t -> !t.isEmpty()).orElse(defaultEventType(resource));

        // Phase L2: reuse the resource's READ op auth. The subscribe route is gated by the same
        // op-tier authorize(OPERATIONS.<ReadOp>) the read handler runs, so a caller who cannot
        // read the resource cannot subscribe to its events.
        Map<CrudVerb, OperationShape> ops = index.lifecycleOps(resource);
        Optional<OperationShape> readOp = Optional.ofNullable(ops.get(CrudVerb.READ));
        boolean authGate = readOp.map(routeEmitter::needsAuthorize).orElse(false);
        String readOpName = readOp.map(op -> op.getId().getName()).orElse(null);

        // Phase L2 (the IDOR fix): when the resource is owner/tenant-scoped, the subscribe route
        // must reproduce the read op's RESOURCE-tier scope, not just its op-tier permission —
        // otherwise a caller with the read permission but scoped out of a row can still subscribe
        // to that row's channel (the hub is an app singleton that can't carry the principal).
        boolean scoped = persisted.getOwnerField().isPresent() || persisted.getTenantField().isPresent();

        // The entity Data type for DataStore<Entity> (the router always takes the scoped store for
        // a stable API; the guard is emitted only when scoped). Falls back to `unknown` when the
        // read output isn't a single-member wrapper (interface-only resource).
        Optional<Shape> entityOpt = index.entityShape(resource);
        String entityType = entityOpt
            .map(e -> ZodEmitter.safeTypeName(e.getId().getName())).orElse("unknown");
        String entityModule = entityOpt
            .map(e -> sharedShapeIds.contains(e.getId()) ? "./shared.gen" : "./" + groupFileStem + ".gen")
            .orElse(null);

        // The bound 404 NotFound error the guard throws on a cross-owner/tenant miss (only needed
        // when scoped). Mirrors CrudEmitter's resolution + import routing (./errors.gen when hoisted).
        Optional<StructureShape> notFoundShape = scoped ? boundError(ops, 404) : Optional.empty();
        String notFound = notFoundShape.map(s -> s.getId().getName()).orElse(null);
        String notFoundModule = notFoundShape
            .map(s -> sharedErrorIds.contains(s.getId()) ? "./errors.gen" : "./" + groupFileStem + ".gen")
            .orElse(null);
        boolean emitGuard = scoped && notFound != null;

        // AUTHZ-01 / CODEGEN-EMIT-2-06 (realtime): surface the unscoped-but-authenticated case —
        // an authenticated @live resource without owner/tenant scoping exposes its event channel
        // to EVERY authenticated caller (the op-tier permission is the only gate). Warn (or fail
        // under enforceResourceScoping) mirroring CrudEmitter.warnIfUnscoped.
        boolean unscopedAuthed = !scoped && authGate && !persisted.isAllowUnscoped();
        warnIfUnscoped(resource, unscopedAuthed);

        TypeScriptFileWriter w = new TypeScriptFileWriter();
        w.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
        w.blank();

        // Imports — the realtime port + helper come from the opt-in @smithy-hono/realtime package.
        w.line("import { Hono } from 'hono'");
        if (emitGuard) {
            w.line("import type { Context } from 'hono'");
        }
        w.line("import type { SecurityEnv } from '" + securityCoreImport + "'");
        if (authGate) {
            w.line("import { authorize } from '" + securityCoreImport + "'");
            w.line("import { OPERATIONS } from './registry.gen'");
        }
        // The router signature takes DataStore<Entity> for a stable API (guard emitted only when
        // scoped); DataScope is referenced only by the scopeFrom helper.
        w.line("import type { DataStore" + (emitGuard ? ", DataScope" : "") + " } from '"
            + DATA_CORE_IMPORT + "'");
        if (entityModule != null) {
            w.line("import type { " + entityType + " } from '" + entityModule + "'");
        }
        if (emitGuard) {
            w.line("import { " + notFound + " } from '" + notFoundModule + "'");
        }
        w.line("import type { RealtimeHub } from '" + REALTIME_IMPORT + "'");
        w.line("import { liveEventStream } from '" + REALTIME_IMPORT + "'");
        w.blank();

        // Event types the endpoint forwards to subscribers.
        w.comment("---- Live event types ----");
        w.blank();
        String typesList = String.join(", ",
            eventTypes.stream().map(TypeScriptFileWriter::stringLiteral).toList());
        w.line("export const " + eventTypesConst + " = [" + typesList + "] as const");
        w.blank();

        // Entitlement scope helper — threads the principal's owner/tenant id into the DataScope,
        // only the keys the @persisted config declares (mirrors CrudEmitter.scopeFrom). Fail-closed
        // if the principal is missing so a misconfigured auth middleware cannot collapse every row
        // into one empty-owner partition.
        if (emitGuard) {
            emitScopeFrom(w, persisted);
        }

        // Router.
        w.comment("---- Live subscribe router ----");
        w.blank();
        emitRouterJsDoc(w, resource, scoped, cfg.isPushRecords());
        w.line("export function " + routerFn + "(hub: RealtimeHub, store: DataStore<" + entityType
            + ">): Hono<SecurityEnv> {");
        w.line("  const app = new Hono<SecurityEnv>()");
        w.blank();
        w.line("  // GET " + routePath + " — subscribe to realtime updates for a single "
            + resource.getId().getName() + ".");
        if (authGate) {
            w.line("  // Gated by the SAME op-tier authorize() the read op (" + readOpName
                + ") uses: a caller who");
            w.line("  // cannot read the resource cannot subscribe to its events (Phase L2).");
        } else {
            w.line("  // The read op is anonymous/optional-auth, so subscribing is ungated too — "
                + "matching read.");
        }
        StringBuilder route = new StringBuilder("  app.get('" + routePath + "'");
        if (authGate) {
            route.append(",\n    authorize(OPERATIONS.").append(readOpName).append(")");
        }
        route.append(",\n    async (c) => {");
        w.line(route.toString());
        w.line("      const " + key + " = c.req.param('" + key + "')");
        if (emitGuard) {
            // Resource-tier entitlement: mirror the read op's owner/tenant scope so a caller who
            // would 404 on the read cannot subscribe to the channel. Fail closed (404), do not
            // leak existence — exactly like createDefault...Operations' read.
            w.line("      // Resource-tier entitlement (Phase L2): reproduce the read op's owner/tenant");
            w.line("      // scope so a caller scoped OUT of this row cannot subscribe to its channel.");
            w.line("      // 404 (not 403) so existence is not leaked — identical to the read op.");
            w.line("      const existing = await store.get(" + key + ", scopeFrom(c))");
            w.line("      if (!existing) throw new " + notFound + "(`not found: ${" + key + "}`)");
        }
        // channelId is ALWAYS `${lowercasedResource}:${id}` — the PINNED convention the runtime
        // (L0) and CF backend (L4) must match.
        w.line("      const channelId = `" + lower + ":${" + key + "}`");
        w.line("      return liveEventStream(c, hub, channelId, " + eventTypesConst + ")");
        w.line("    }");
        w.line("  )");
        w.blank();
        w.line("  return app");
        w.line("}");
        w.blank();

        // README wiring comment — the one-line composition at the app's entrypoint.
        emitWiringComment(w, resource, groupName, groupFileStem, lower, eventType, cfg, routerFn);

        String fileName = groupFileStem + ".live.gen.ts";
        w.write(manifest, fileName);
        return Optional.of(fileName);
    }

    // ── scopeFrom (copied from CrudEmitter, gated on the declared owner/tenant keys) ──

    private void emitScopeFrom(TypeScriptFileWriter w, PersistedTrait config) {
        List<String> keys = new ArrayList<>();
        config.getOwnerField().ifPresent(f -> keys.add("ownerId: p.id"));
        config.getTenantField().ifPresent(f -> keys.add("tenantId: p.tenantId"));

        w.comment("---- Entitlement scope ----");
        w.blank();
        w.line("function scopeFrom(c?: Context<SecurityEnv>): DataScope {");
        w.line("  const p = c?.get('principal')");
        w.line("  if (!p) throw new Error('scopeFrom: missing authenticated principal — this resource declares owner/tenant scoping and must be mounted behind @requiresAuth')");
        w.line("  return { " + String.join(", ", keys) + " }");
        w.line("}");
        w.blank();
    }

    // ── Router JSDoc ─────────────────────────────────────────────────────────────

    private void emitRouterJsDoc(TypeScriptFileWriter w, ResourceShape resource, boolean scoped,
                                 boolean pushRecords) {
        w.line("/**");
        w.line(" * Subscribe router for " + resource.getId().getName()
            + " realtime events. Mount with the RAW scoped store");
        w.line(" * (the entitlement guard needs the un-decorated store); wrap that same store with");
        w.line(" * withLiveNotify(store, hub, ...) for the ops factory (see wiring comment below).");
        if (scoped) {
            w.line(" *");
            w.line(" * Owner/tenant-scoped: BEFORE subscribing, the router runs");
            w.line(" * `store.get(id, scopeFrom(c))` and 404s on null, mirroring the read op's");
            w.line(" * resource-tier scope so a caller scoped out of a row cannot observe its channel.");
        } else {
            // DANGER note in the generated artifact (mirrors CrudEmitter's unscoped JSDoc).
            w.line(" *");
            w.line(" * NO owner/tenant isolation: this @live resource declares neither `ownerField`");
            w.line(" * nor `tenantField`, so the subscribe route is gated ONLY by the read op's");
            w.line(" * op-tier permission — every authenticated caller holding that permission can");
            w.line(" * subscribe to ANY id's event channel (and observe its version-advances). Add");
            w.line(" * `ownerField`/`tenantField` to `@persisted` to scope the channel per owner/tenant,");
            w.line(" * unless the resource is intentionally single-tenant/public.");
        }
        if (pushRecords) {
            // The residual afterRead-hook case (hooks aren't statically detectable): F2.
            w.line(" *");
            w.line(" * DANGER (pushRecords): record frames ship the FULL record body to every");
            w.line(" * subscriber and BYPASS any per-recipient afterRead redaction hook. Confirm every");
            w.line(" * subscriber is entitled to the identical projection; otherwise leave pushRecords");
            w.line(" * off and let each client refetch its own server-redacted view.");
            w.line(" * DANGER (pushRecords): requires the Durable Object (push) backend — the polling");
            w.line(" * backend cannot ship record frames and will deliver only version hints");
            w.line(" * (withLiveNotify throws if pushRecords is paired with the polling backend).");
        }
        w.line(" */");
    }

    // ── Unscoped advisory ────────────────────────────────────────────────────────

    private void warnIfUnscoped(ResourceShape resource, boolean unscopedAuthed) {
        if (!unscopedAuthed) return;
        if (enforceResourceScoping) {
            throw new software.amazon.smithy.codegen.core.CodegenException(String.format(
                "enforceResourceScoping is ON and @live resource %s declares neither ownerField nor "
                + "tenantField but its read op requires auth — its generated subscribe route is gated "
                + "only by the op-tier read permission, so every authenticated caller holding it can "
                + "subscribe to ANY id's event channel (IDOR). Add ownerField/tenantField to "
                + "@persisted, or — if the resource is intentionally single-tenant/public — set "
                + "allowUnscoped: true on @persisted to opt out explicitly.",
                resource.getId().getName()));
        }
        LOGGER.warning(String.format(
            "DANGER: @live resource %s declares neither ownerField nor tenantField but its read op "
            + "requires auth — the generated subscribe route is gated only by the op-tier read "
            + "permission, so every authenticated caller holding it can subscribe to ANY id's event "
            + "channel and observe its version-advances (IDOR). Add ownerField/tenantField to "
            + "@persisted to scope the channel per owner/tenant, or confirm the resource is "
            + "intentionally single-tenant/public.",
            resource.getId().getName()));
    }

    /** The bound error SHAPE with the given HTTP status across the resource's lifecycle ops. */
    private Optional<StructureShape> boundError(Map<CrudVerb, OperationShape> ops, int status) {
        for (OperationShape op : ops.values()) {
            for (StructureShape err : index.getAllErrors(op)) {
                if (err.getTrait(HttpErrorTrait.class).map(HttpErrorTrait::getCode).orElse(-1) == status) {
                    return Optional.of(err);
                }
            }
        }
        return Optional.empty();
    }

    /**
     * The README comment showing the one-line composition wiring. Notify-on-commit is a store
     * decorator ({@code withLiveNotify}), NOT a factory change — the CRUD factory is untouched.
     * The router takes the RAW scoped store (for the entitlement guard); the ops factory takes the
     * notify-decorated store.
     */
    private void emitWiringComment(TypeScriptFileWriter w, ResourceShape resource, String groupName,
                                   String groupFileStem, String lower, String eventType,
                                   LiveTrait cfg, String routerFn) {
        String factoryName = "createDefault" + groupName + "Operations";
        String opts = "{ resource: '" + lower + "', eventType: '" + eventType + "'"
            + (cfg.isPushRecords() ? ", pushRecords: true" : "") + " }";
        w.comment("---- Composition wiring (copy to your app entrypoint) ----");
        w.comment("");
        w.comment("Notify-on-commit is a STORE DECORATOR (withLiveNotify), not a factory change —");
        w.comment("wrap the DataStore you already pass to " + factoryName + " for the ops, but mount");
        w.comment("the router with the RAW store so its owner/tenant entitlement guard runs on the");
        w.comment("un-decorated read path:");
        w.comment("");
        w.comment("  import { withLiveNotify } from '" + REALTIME_IMPORT + "'");
        w.comment("  import { " + factoryName + " } from './" + groupFileStem + ".crud.gen'");
        w.comment("  import { " + routerFn + " } from './" + groupFileStem + ".live.gen'");
        w.comment("");
        w.comment("  const liveStore = withLiveNotify(store, hub, " + opts + ")");
        w.comment("  const ops = " + factoryName + "(liveStore, hooks)");
        w.comment("  app.route('/', " + routerFn + "(hub, store))");
    }
}
