package com.smithyhono.validators;

import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * CG-08: the generated metadata registry keys {@code OPERATIONS} by an operation's
 * SIMPLE name and {@code OPERATION_BY_ROUTE} by method+path. Two operations with the
 * same simple name in different namespaces (legal in Smithy), or two ops that route
 * to the same method+path, therefore collide into the SAME object key — the second
 * silently overwrites the first (last wins). The router's
 * {@code authorize(OPERATIONS.X)} then reads the wrong operation's metadata
 * (permissions, auth scheme): a security-relevant correctness bug.
 *
 * <p>This makes both collisions a build ERROR. The route check normalizes path-label
 * NAMES ({@code /items/{id}} and {@code /items/{x}} route identically in Hono), so a
 * label-name-only difference is caught even though the literal URIs differ.
 */
public final class OperationCollisionValidator extends AbstractValidator {

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();
        TopDownIndex topDown = TopDownIndex.of(model);

        for (ServiceShape service : model.getServiceShapes()) {
            List<OperationShape> ops = topDown.getContainedOperations(service).stream()
                .filter(op -> op.hasTrait(HttpTrait.class))
                .collect(Collectors.toList());

            checkSimpleNameCollisions(service, ops, events);
            checkRouteCollisions(service, ops, events);
        }
        return events;
    }

    private void checkSimpleNameCollisions(
            ServiceShape service, List<OperationShape> ops, List<ValidationEvent> events) {
        Map<String, List<OperationShape>> bySimpleName = new LinkedHashMap<>();
        for (OperationShape op : ops) {
            bySimpleName.computeIfAbsent(op.getId().getName(), k -> new ArrayList<>()).add(op);
        }
        for (Map.Entry<String, List<OperationShape>> entry : bySimpleName.entrySet()) {
            if (entry.getValue().size() < 2) continue;
            events.add(error(service,
                "Service `" + service.getId().getName() + "` has " + entry.getValue().size()
                    + " operations with the colliding simple name `" + entry.getKey() + "` ["
                    + idList(entry.getValue()) + "] (CG-08). The metadata registry keys OPERATIONS by "
                    + "simple name, so these overwrite each other and the authZ hook reads the wrong "
                    + "operation's metadata. Rename one, or split them into separate services."));
        }
    }

    private void checkRouteCollisions(
            ServiceShape service, List<OperationShape> ops, List<ValidationEvent> events) {
        Map<String, List<OperationShape>> byRoute = new LinkedHashMap<>();
        for (OperationShape op : ops) {
            HttpTrait http = op.expectTrait(HttpTrait.class);
            String route = http.getMethod().toUpperCase() + " " + normalizeUri(http.getUri().toString());
            byRoute.computeIfAbsent(route, k -> new ArrayList<>()).add(op);
        }
        for (Map.Entry<String, List<OperationShape>> entry : byRoute.entrySet()) {
            if (entry.getValue().size() < 2) continue;
            events.add(error(service,
                "Service `" + service.getId().getName() + "` routes " + entry.getValue().size()
                    + " operations to the same endpoint `" + entry.getKey() + "` ["
                    + idList(entry.getValue()) + "] (CG-08). They collide on the method+path registry "
                    + "key and in Hono routing. Give each a distinct method/path."));
        }
    }

    /** Collapses path-label names so {@code /items/{id}} and {@code /items/{x}} compare equal. */
    private static String normalizeUri(String uri) {
        return uri.replaceAll("\\{[^}]+}", "{}");
    }

    private static String idList(List<OperationShape> ops) {
        return ops.stream().map(op -> op.getId().toString()).collect(Collectors.joining(", "));
    }
}
