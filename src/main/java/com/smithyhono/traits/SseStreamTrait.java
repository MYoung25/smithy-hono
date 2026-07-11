package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AnnotationTrait;

/**
 * Marks an HTTP operation as a streaming (Server-Sent-Events) endpoint, surfaced
 * as {@code streaming: true} in the metadata registry so the security-headers
 * middleware skips {@code Cache-Control: no-store} on the response (HDR-07
 * route-class).
 *
 * <pre>@sseStream</pre>
 */
public final class SseStreamTrait extends AnnotationTrait {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#sseStream");

    public SseStreamTrait(software.amazon.smithy.model.node.ObjectNode node) {
        super(ID, node);
    }

    public SseStreamTrait() {
        this(Node.objectNode());
    }

    public static final class Provider extends AnnotationTrait.Provider<SseStreamTrait> {
        public Provider() {
            super(ID, SseStreamTrait::new);
        }
    }
}
