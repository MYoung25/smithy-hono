package com.smithyhono.validators;

import com.smithyhono.traits.LiveTrait;
import com.smithyhono.traits.PersistedTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.SensitiveTrait;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Phase L1: enforces the invariants the generated realtime router + notify wiring rely on for a
 * {@code @live} resource. Mirrors {@link PersistedResourceValidator}'s structure (clear build
 * ERRORs for hard violations; a WARNING advisory for the ambiguous redaction case).
 *
 * <ul>
 *   <li>{@code @live} requires {@code @persisted} on the same resource (the trait selector
 *       enforces this, but a build path that misses the selector still gets a clear ERROR — the
 *       generated code has no {@code version} cursor / store key without it).</li>
 *   <li>{@code keyMember} (or the defaulted resource identifier) must be a resource identifier
 *       member — it is both the channel key and the DataStore key.</li>
 *   <li>{@code pushRecords: true} requires a non-projected read output: it is an ERROR when the
 *       resource has owner/tenant scoping ({@code @persisted.ownerField}/{@code tenantField}) OR
 *       any {@code @sensitive}-reachable read-output member — the two machine-detectable
 *       per-recipient projection signals (broadcasting one record body to owners/tenants or
 *       recipients who must see different projections leaks data). With no such signal it is a
 *       WARNING advisory that record frames still bypass any (statically undetectable)
 *       {@code afterRead} redaction hook.</li>
 *   <li>The synthetic live subscribe route ({@code GET /<resource>/:id/events}) and op name
 *       ({@code <Resource>LiveSubscribe}) must not collide with a modeled operation route/shape.</li>
 * </ul>
 *
 * <p>Only fires for {@code @live} resources — everything else is unaffected.
 */
public final class LiveResourceValidator extends AbstractValidator {

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();
        for (ResourceShape resource : model.getResourceShapes()) {
            if (!resource.hasTrait(LiveTrait.class)) continue;
            validateResource(model, resource, events);
        }
        return events;
    }

    private void validateResource(Model model, ResourceShape resource, List<ValidationEvent> events) {
        String name = resource.getId().getName();
        LiveTrait cfg = resource.expectTrait(LiveTrait.class);

        // 1. @live requires @persisted.
        if (!resource.hasTrait(PersistedTrait.class)) {
            events.add(error(resource,
                "@live resource `" + name + "` is not @persisted (Phase L1). @live only adds an "
                    + "observation channel over the version cursor + store key that @persisted "
                    + "owns; add @persisted to the resource."));
            return; // the remaining checks depend on the persisted identifier
        }

        // 2. keyMember (or the defaulted identifier) must be a resource identifier member.
        Set<String> identifiers = resource.getIdentifiers().keySet();
        Optional<String> declaredKey = cfg.getKeyMember().filter(m -> !m.isEmpty());
        if (declaredKey.isPresent()) {
            if (!identifiers.contains(declaredKey.get())) {
                events.add(error(resource,
                    "@live resource `" + name + "` sets keyMember `" + declaredKey.get()
                        + "` which is not a resource identifier " + identifiers + " (Phase L1). The "
                        + "channel key must be the DataStore key, i.e. a resource identifier member."));
            }
        } else if (identifiers.isEmpty()) {
            events.add(error(resource,
                "@live resource `" + name + "` declares no identifier to key the channel on "
                    + "(Phase L1). Declare a single string identifier (see @persisted) or set an "
                    + "explicit keyMember."));
        }

        // 3. pushRecords: true — validate against per-recipient projection signals.
        if (cfg.isPushRecords()) {
            validatePushRecords(model, resource, name, events);
        }

        // 4. The synthetic live subscribe route/op must not collide with a modeled op.
        validateNoCollision(model, resource, cfg, name, events);
    }

    private void validatePushRecords(Model model, ResourceShape resource, String name,
                                     List<ValidationEvent> events) {
        PersistedTrait persisted = resource.getTrait(PersistedTrait.class).orElse(null);
        boolean scoped = persisted != null
            && (persisted.getOwnerField().isPresent() || persisted.getTenantField().isPresent());

        Optional<StructureShape> readOutput = readOutput(model, resource);
        List<String> sensitivePaths = new ArrayList<>();
        readOutput.ifPresent(out -> collectSensitive(model, out, "", sensitivePaths, new HashSet<>()));

        // Machine-detectable per-recipient projection signals: owner/tenant scoping (the row is
        // owner-scoped, so one body cannot be broadcast to all subscribers) OR any @sensitive
        // reachable output member. Either is a hard ERROR — record frames would leak a projection.
        if (scoped || !sensitivePaths.isEmpty()) {
            List<String> reasons = new ArrayList<>();
            if (scoped) {
                reasons.add("the resource is owner/tenant-scoped ("
                    + (persisted.getOwnerField().isPresent() ? "ownerField" : "tenantField")
                    + "), so its rows are per-recipient projections");
            }
            if (!sensitivePaths.isEmpty()) {
                reasons.add("its read output carries @sensitive member(s) " + sensitivePaths);
            }
            events.add(error(resource,
                "@live resource `" + name + "` sets pushRecords: true but " + String.join(" and ", reasons)
                    + " (Phase L1). Record frames broadcast ONE record body to ALL subscribers, so an "
                    + "owner/tenant- or @sensitive-projected view would leak to callers not entitled to "
                    + "it. Drop pushRecords (default {id, version} hints let each client refetch its own "
                    + "server-scoped/redacted view) or remove the projection signal from the observed "
                    + "output."));
            return;
        }

        if (readOutput.isEmpty()) {
            // No read output to reason about and no scoping signal — advise, don't hard-fail. The id
            // suffix is prefixed with the validator name -> "LiveResource.PushRecordsUnverified".
            events.add(warning(resource,
                "@live resource `" + name + "` sets pushRecords: true but has no resolvable read "
                    + "output to check for redaction (Phase L1). Record frames ship the full record "
                    + "body to every subscriber — ensure no subscriber must see a different "
                    + "projection, or leave pushRecords off and let each client refetch its own "
                    + "server-redacted view.",
                "PushRecordsUnverified"));
            return;
        }

        // No statically-detectable projection signal — DANGER advisory that record frames still
        // bypass any (statically undetectable) afterRead redaction hook. The id suffix is prefixed
        // with the validator name -> "LiveResource.PushRecordsMayLeak".
        events.add(warning(resource,
            "@live resource `" + name + "` sets pushRecords: true (Phase L1). No owner/tenant scoping "
                + "or @sensitive members were detected on its read output, but record frames ship the "
                + "full record body to every subscriber and BYPASS any per-recipient afterRead "
                + "redaction hook (hooks are not statically detectable). Confirm every subscriber is "
                + "entitled to the identical projection; otherwise leave pushRecords off and let clients "
                + "refetch their own redacted view.",
            "PushRecordsMayLeak"));
    }

    /**
     * ERRORs when the synthetic live subscribe route ({@code GET /<resource>/:id/events}) collides
     * with a modeled operation's route, or when a shape named {@code <Resource>LiveSubscribe}
     * already exists in the resource's namespace (colliding with the synthetic registry op). The
     * generated router/registry would otherwise silently shadow or duplicate the modeled binding.
     */
    private void validateNoCollision(Model model, ResourceShape resource, LiveTrait cfg, String name,
                                     List<ValidationEvent> events) {
        // Synthetic route path, param-name-normalized so a real GET /<resource>/:foo/events collides
        // regardless of the label name.
        String lower = resource.getId().getName().toLowerCase(Locale.ROOT);
        String liveNormalized = normalizePath("/" + lower + "/:x/events");
        for (OperationShape op : model.getOperationShapes()) {
            HttpTrait http = op.getTrait(HttpTrait.class).orElse(null);
            if (http == null) continue;
            if (!http.getMethod().equalsIgnoreCase("GET")) continue;
            if (normalizePath(http.getUri().toString()).equals(liveNormalized)) {
                events.add(error(op,
                    "@live resource `" + name + "` generates a synthetic subscribe route `GET /"
                        + lower + "/:" + liveKey(resource, cfg) + "/events`, but modeled operation `"
                        + op.getId().getName() + "` already binds a colliding route `"
                        + http.getMethod() + " " + http.getUri() + "` (Phase L1). Rename/remove the "
                        + "modeled op or the @live channel would shadow it."));
            }
        }

        // Synthetic registry op name collision.
        ShapeId syntheticOp = ShapeId.fromParts(resource.getId().getNamespace(), name + "LiveSubscribe");
        if (model.getShape(syntheticOp).isPresent()) {
            events.add(error(resource,
                "@live resource `" + name + "` synthesizes a registry operation `" + name
                    + "LiveSubscribe`, but a shape with that id already exists (" + syntheticOp
                    + ") (Phase L1). Rename the modeled shape — the synthetic live op would collide."));
        }
    }

    /** The channel key member for diagnostics (declared keyMember or the sole identifier). */
    private String liveKey(ResourceShape resource, LiveTrait cfg) {
        return cfg.getKeyMember().filter(m -> !m.isEmpty())
            .orElseGet(() -> {
                Set<String> ids = resource.getIdentifiers().keySet();
                return ids.isEmpty() ? "id" : ids.iterator().next();
            });
    }

    /**
     * Normalizes an HTTP path to a structural form for collision comparison: strips any query
     * string, then replaces each Smithy {@code {label}} or Hono {@code :label} path segment with a
     * placeholder {@code :x} so two routes that differ only by label name compare equal.
     */
    private String normalizePath(String uri) {
        String path = uri;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        String[] segments = path.split("/", -1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < segments.length; i++) {
            if (i > 0) sb.append('/');
            String seg = segments[i];
            if ((seg.startsWith("{") && seg.endsWith("}")) || seg.startsWith(":")) {
                sb.append(":x");
            } else {
                sb.append(seg);
            }
        }
        return sb.toString();
    }

    /** The read op's output structure for the resource, if resolvable. */
    private Optional<StructureShape> readOutput(Model model, ResourceShape resource) {
        return resource.getRead()
            .flatMap(id -> model.getShape(id).flatMap(Shape::asOperationShape))
            .flatMap(OperationShape::getOutput)
            .flatMap(id -> model.getShape(id).flatMap(Shape::asStructureShape));
    }

    /**
     * Collects dot-paths of every {@code @sensitive} member reachable from the structure (member
     * OR its target carries {@code @sensitive}), walking nested structures with a cycle guard.
     * Mirrors {@code ModelIndex.sensitiveFieldPaths} — the validator has no ModelIndex.
     */
    private void collectSensitive(Model model, StructureShape struct, String prefix,
                                  List<String> out, Set<ShapeId> seen) {
        if (!seen.add(struct.getId())) return;
        for (Map.Entry<String, MemberShape> e : struct.getAllMembers().entrySet()) {
            MemberShape m = e.getValue();
            Shape target = model.expectShape(m.getTarget());
            String path = prefix.isEmpty() ? e.getKey() : prefix + "." + e.getKey();
            if (m.hasTrait(SensitiveTrait.class) || target.hasTrait(SensitiveTrait.class)) {
                out.add(path);
            }
            target.asStructureShape().ifPresent(ts -> collectSensitive(model, ts, path, out, seen));
        }
    }
}
