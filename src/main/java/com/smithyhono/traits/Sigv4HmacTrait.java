package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AnnotationTrait;

/**
 * Marks an operation (or service) as requiring the custom SH-HMAC-SHA256
 * service-to-service request signing scheme (SIGN-*). Surfaces in the metadata
 * registry as an {@code { type: 'sigv4Hmac' }} auth scheme so the runtime
 * signature-verification middleware (Phase S6) engages for the operation.
 *
 * <pre>@sigv4Hmac</pre>
 */
public final class Sigv4HmacTrait extends AnnotationTrait {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#sigv4Hmac");

    public Sigv4HmacTrait(software.amazon.smithy.model.node.ObjectNode node) {
        super(ID, node);
    }

    public Sigv4HmacTrait() {
        this(Node.objectNode());
    }

    public static final class Provider extends AnnotationTrait.Provider<Sigv4HmacTrait> {
        public Provider() {
            super(ID, Sigv4HmacTrait::new);
        }
    }
}
