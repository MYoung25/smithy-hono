package com.smithyhono.validators;

import com.smithyhono.traits.PersistedTrait;
import com.smithyhono.traits.RequiresAuthTrait;
import com.smithyhono.traits.Sigv4HmacTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.ServiceIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpBearerAuthTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpLabelTrait;
import software.amazon.smithy.model.traits.OptionalAuthTrait;
import software.amazon.smithy.model.traits.Trait;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Plan 13 (P2): enforces the "Hard requirements (build-time validated, fail fast)"
 * for resources carrying {@code @persisted}. The generated default CRUD impl relies
 * on these invariants (the router catch only maps modeled error classes bound to the
 * op), so a violation must be a clear build ERROR rather than a silent 500.
 *
 * <p>Only fires for {@code @persisted} resources — non-persisted resources/services
 * are unaffected.
 *
 * <ul>
 *   <li>Exactly one string identifier (composite keys → error; non-string id → error).</li>
 *   <li>{@code read}/{@code update}/{@code delete} must each bind a {@code @httpError(404)}
 *       error shape.</li>
 *   <li>{@code optimisticConcurrency: true} requires a reachable {@code @httpError(409)}.</li>
 *   <li>The {@code read} op's {@code @httpLabel} must bind the resource identifier.</li>
 * </ul>
 */
public final class PersistedResourceValidator extends AbstractValidator {

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();
        for (ResourceShape resource : model.getResourceShapes()) {
            if (!resource.hasTrait(PersistedTrait.class)) continue;
            validateResource(model, resource, events);
        }
        return events;
    }

    private void validateResource(Model model, ResourceShape resource, List<ValidationEvent> events) {
        String name = resource.getId().getName();
        Map<String, ShapeId> identifiers = resource.getIdentifiers();

        // 1. Exactly one identifier, and it must be a string.
        String idMember = null;
        if (identifiers.isEmpty()) {
            events.add(error(resource,
                "@persisted resource `" + name + "` declares no identifier (Plan 13). "
                    + "Exactly one string identifier is required."));
        } else if (identifiers.size() > 1) {
            events.add(error(resource,
                "@persisted resource `" + name + "` declares " + identifiers.size()
                    + " identifiers " + identifiers.keySet() + " (Plan 13). Composite keys are "
                    + "deferred; exactly one string identifier is required."));
        } else {
            Map.Entry<String, ShapeId> only = identifiers.entrySet().iterator().next();
            idMember = only.getKey();
            Shape idTarget = model.expectShape(only.getValue());
            if (!idTarget.isStringShape()) {
                events.add(error(resource,
                    "@persisted resource `" + name + "` identifier `" + idMember + "` targets "
                        + idTarget.getType() + " (Plan 13). The MVP requires a string identifier."));
            }
        }

        // 2. read/update/delete must each bind a @httpError(404).
        checkErrorBound(model, resource, resource.getRead(), "read", 404, events);
        checkErrorBound(model, resource, resource.getUpdate(), "update", 404, events);
        checkErrorBound(model, resource, resource.getDelete(), "delete", 404, events);

        // 3. optimisticConcurrency: true requires a reachable @httpError(409) on a write op.
        PersistedTrait config = resource.expectTrait(PersistedTrait.class);
        if (config.isOptimisticConcurrency()) {
            boolean has409 = opBindsErrorCode(model, resource.getUpdate(), 409)
                || opBindsErrorCode(model, resource.getPut(), 409)
                || opBindsErrorCode(model, resource.getDelete(), 409)
                || opBindsErrorCode(model, resource.getCreate(), 409);
            if (!has409) {
                events.add(error(resource,
                    "@persisted resource `" + name + "` sets optimisticConcurrency: true but no "
                        + "lifecycle operation binds a @httpError(409) (Plan 13). The port's conflict "
                        + "error must be rethrown as a modeled 409 or it silently becomes a 500."));
            }
        }

        // 4. The read op's @httpLabel must bind the resource identifier.
        if (idMember != null) {
            Optional<OperationShape> read = resource.getRead().map(id -> model.expectShape(id, OperationShape.class));
            if (read.isPresent() && !readLabelBindsIdentifier(model, read.get(), idMember)) {
                events.add(error(read.get(),
                    "@persisted resource `" + name + "` read op `" + read.get().getId().getName()
                        + "` must bind the identifier `" + idMember + "` as an @httpLabel (Plan 13)."));
            }
        }

        // 5. Unscoped-IDOR advisory (AUTHZ-01 / CODEGEN-EMIT-2-06). WARNING (non-failing, on by
        //    default) mirroring CrudEmitter.warnIfUnscoped: a @persisted resource that declares
        //    NEITHER ownerField NOR tenantField yet has ≥1 authenticated lifecycle op generates a
        //    CRUD layer with an empty DataScope — every authenticated caller can reach every
        //    record (IDOR). Suppressed when scoped, when no op is authenticated, or when the
        //    resource opts out with allowUnscoped: true.
        maybeWarnUnscoped(model, resource, config, events);
    }

    /**
     * Emits {@code PersistedResource.UnscopedIdor} (WARNING) for an authenticated, unscoped
     * {@code @persisted} resource that hasn't set {@code allowUnscoped: true}. Mirrors the exact
     * condition in {@code CrudEmitter.warnIfUnscoped}.
     */
    private void maybeWarnUnscoped(Model model, ResourceShape resource, PersistedTrait config,
                                   List<ValidationEvent> events) {
        if (config.getOwnerField().isPresent() || config.getTenantField().isPresent()) return;
        if (config.isAllowUnscoped()) return;

        Optional<ServiceShape> service = enclosingService(model, resource);
        boolean anyAuthenticated = lifecycleOps(model, resource).stream()
            .anyMatch(op -> requiresAuth(model, service.orElse(null), op));
        if (!anyAuthenticated) return;

        events.add(ValidationEvent.builder()
            .id("PersistedResource.UnscopedIdor")
            .severity(Severity.WARNING)
            .shape(resource)
            .message("@persisted resource `" + resource.getId().getName() + "` declares neither "
                + "ownerField nor tenantField but has authenticated lifecycle ops — its generated "
                + "CRUD runs with an empty DataScope and provides NO owner/tenant isolation: every "
                + "authenticated caller can read/update/delete every record (IDOR). Add ownerField/"
                + "tenantField to @persisted, guard the id-addressed ops with requireResourcePolicy "
                + "(isOwner()/sameTenant()), or — if the resource is intentionally single-tenant/"
                + "public — set allowUnscoped: true on @persisted to opt out explicitly.")
            .build());
    }

    /** The @persisted lifecycle ops actually bound by the resource (create/read/update/delete/put/list). */
    private List<OperationShape> lifecycleOps(Model model, ResourceShape resource) {
        List<OperationShape> ops = new ArrayList<>();
        for (Optional<ShapeId> opId : List.of(resource.getCreate(), resource.getRead(),
                resource.getUpdate(), resource.getDelete(), resource.getPut(), resource.getList())) {
            opId.flatMap(id -> model.getShape(id).flatMap(Shape::asOperationShape)).ifPresent(ops::add);
        }
        return ops;
    }

    /** The service that transitively contains the resource, if any. */
    private Optional<ServiceShape> enclosingService(Model model, ResourceShape resource) {
        TopDownIndex topDown = TopDownIndex.of(model);
        for (ServiceShape service : model.getServiceShapes()) {
            if (topDown.getContainedResources(service).contains(resource)) {
                return Optional.of(service);
            }
        }
        return Optional.empty();
    }

    /**
     * True when the op carries a non-anonymous auth scheme (an authenticated principal must reach
     * the handler). Replicates {@code ModelIndex.authSchemesFor} — the validator has no ModelIndex.
     */
    private boolean requiresAuth(Model model, ServiceShape service, OperationShape op) {
        boolean optionalAuth = op.hasTrait(OptionalAuthTrait.class);
        Set<String> schemes = new LinkedHashSet<>();

        if (service != null) {
            Map<ShapeId, Trait> effective = ServiceIndex.of(model).getEffectiveAuthSchemes(service, op);
            for (ShapeId schemeId : effective.keySet()) {
                String mapped = mapAuthScheme(schemeId);
                if (mapped != null) schemes.add(mapped);
            }
        }
        if (op.hasTrait(Sigv4HmacTrait.class)) schemes.add("sigv4Hmac");
        if (op.hasTrait(RequiresAuthTrait.class) && schemes.isEmpty()) schemes.add("oidc");

        List<String> resolved;
        if (schemes.isEmpty()) {
            resolved = optionalAuth ? List.of("anonymous") : List.of();
        } else {
            resolved = new ArrayList<>(schemes);
        }
        return resolved.stream().anyMatch(s -> !s.equals("anonymous"));
    }

    private String mapAuthScheme(ShapeId schemeId) {
        String schemeName = schemeId.toString();
        if (schemeName.equals(HttpBearerAuthTrait.ID.toString())) return "oidc";
        if (schemeName.equals(Sigv4HmacTrait.ID.toString())) return "sigv4Hmac";
        if (schemeName.equals("smithy.api#noAuth")) return "anonymous";
        return "oidc";
    }

    /** Whether an op exists and binds an error with the given HTTP status code. */
    private void checkErrorBound(Model model, ResourceShape resource, Optional<ShapeId> opId,
                                 String verb, int code, List<ValidationEvent> events) {
        if (opId.isEmpty()) return; // resource may not bind this verb
        if (!opBindsErrorCode(model, opId, code)) {
            OperationShape op = model.expectShape(opId.get(), OperationShape.class);
            events.add(error(op,
                "@persisted resource `" + resource.getId().getName() + "` " + verb + " op `"
                    + op.getId().getName() + "` binds no @httpError(" + code + ") error (Plan 13). "
                    + "The generated impl throws it on miss and the router only maps errors bound to "
                    + "the op — without it the miss silently becomes a 500."));
        }
    }

    private boolean opBindsErrorCode(Model model, Optional<ShapeId> opId, int code) {
        if (opId.isEmpty()) return false;
        OperationShape op = model.expectShape(opId.get(), OperationShape.class);
        for (ShapeId errorId : op.getErrors()) {
            StructureShape error = model.expectShape(errorId, StructureShape.class);
            if (error.getTrait(HttpErrorTrait.class)
                    .map(HttpErrorTrait::getCode).filter(c -> c == code).isPresent()) {
                return true;
            }
        }
        return false;
    }

    private boolean readLabelBindsIdentifier(Model model, OperationShape read, String idMember) {
        return read.getInput()
            .flatMap(id -> model.getShape(id).flatMap(Shape::asStructureShape))
            .map(input -> {
                MemberShape member = input.getAllMembers().get(idMember);
                return member != null && member.hasTrait(HttpLabelTrait.class);
            })
            .orElse(false);
    }
}
