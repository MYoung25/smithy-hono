package com.smithyhono.validators;

import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.ServiceIndex;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.Trait;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * CG-07: this codegen only emits {@code aws.protocols#restJson1}-shaped routers and
 * validators. Run against an {@code awsJson1_0/1_1}, {@code restXml}, or
 * {@code rpcv2Cbor} service it would silently emit wire-incompatible output (awsJson,
 * for instance, POSTs to {@code /} with {@code X-Amz-Target} and no {@code @http}, so
 * every operation is filtered out and an EMPTY package is produced with no error).
 *
 * <p>This validator makes that a build ERROR instead of silent breakage: if a service
 * <em>explicitly declares</em> a protocol and none of them is restJson1, it fails the
 * build naming the unsupported protocol(s). A service that declares NO protocol trait
 * is left alone — restJson1 is the documented assumed default, and every existing
 * model relies on that implicit posture.
 */
public final class ProtocolValidator extends AbstractValidator {

    private static final ShapeId REST_JSON_1 = ShapeId.from("aws.protocols#restJson1");

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();
        ServiceIndex serviceIndex = ServiceIndex.of(model);

        for (ServiceShape service : model.getServiceShapes()) {
            Map<ShapeId, Trait> protocols = serviceIndex.getProtocols(service);
            // No declared protocol → assumed restJson1 (current behavior). Allow.
            if (protocols.isEmpty()) continue;
            if (protocols.containsKey(REST_JSON_1)) continue;

            String declared = protocols.keySet().stream()
                .map(ShapeId::toString)
                .collect(Collectors.joining(", "));

            events.add(error(service,
                "Service `" + service.getId().getName() + "` declares protocol(s) [" + declared
                    + "] but smithy-hono only supports `" + REST_JSON_1 + "` (CG-07). "
                    + "Apply @restJson1 to the service, or generate it with a restJson1-compatible "
                    + "toolchain — this codegen would otherwise emit wire-incompatible output."));
        }
        return events;
    }
}
