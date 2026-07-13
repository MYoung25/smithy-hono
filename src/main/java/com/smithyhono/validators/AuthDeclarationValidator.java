package com.smithyhono.validators;

import com.smithyhono.traits.RequiresAuthTrait;
import com.smithyhono.traits.Sigv4HmacTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.ServiceIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.traits.AuthTrait;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.OptionalAuthTrait;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.List;

/**
 * AUTH-02: fails the build when an HTTP operation has no auth declaration.
 *
 * <p>An operation is considered declared if it carries any of: {@code @requiresAuth},
 * {@code @auth}, {@code @optionalAuth} (explicit anonymous opt-out), the custom
 * {@code @sigv4Hmac} S2S marker, or inherits a non-empty effective auth scheme set
 * from its service. Otherwise an ERROR event is emitted, making
 * "no operation is unauthenticated unless explicitly annotated" a compile-time
 * guarantee rather than a review checklist.
 */
public final class AuthDeclarationValidator extends AbstractValidator {

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();
        TopDownIndex topDown = TopDownIndex.of(model);
        ServiceIndex serviceIndex = ServiceIndex.of(model);

        for (ServiceShape service : model.getServiceShapes()) {
            for (OperationShape op : topDown.getContainedOperations(service)) {
                // Only HTTP-bound operations are surfaced as routes by this codegen.
                if (!op.hasTrait(HttpTrait.class)) continue;
                if (hasAuthDeclaration(op, service, serviceIndex)) continue;

                events.add(error(op,
                    "Operation `" + op.getId().getName() + "` has no auth declaration (AUTH-01/02). "
                        + "Add @requiresAuth, @auth, @sigv4Hmac, or @optionalAuth to make the "
                        + "authentication posture explicit."));
            }
        }
        return events;
    }

    private boolean hasAuthDeclaration(OperationShape op, ServiceShape service, ServiceIndex serviceIndex) {
        if (op.hasTrait(RequiresAuthTrait.class)) return true;
        if (op.hasTrait(AuthTrait.class)) return true;
        if (op.hasTrait(OptionalAuthTrait.class)) return true;
        if (op.hasTrait(Sigv4HmacTrait.class)) return true;
        return !serviceIndex.getEffectiveAuthSchemes(service, op).isEmpty();
    }
}
