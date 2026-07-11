package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;

public final class SseEventTrait extends AbstractTrait {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#sseEvent");

    private final String eventType;

    private SseEventTrait(String eventType, software.amazon.smithy.model.SourceLocation sourceLocation) {
        super(ID, sourceLocation);
        this.eventType = eventType;
    }

    public String getEventType() { return eventType; }

    @Override
    protected Node createNode() {
        return Node.objectNodeBuilder()
            .withMember("eventType", eventType)
            .build();
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public SseEventTrait createTrait(ShapeId target, Node value) {
            String eventType = value.expectObjectNode()
                .expectStringMember("eventType").getValue();
            return new SseEventTrait(eventType, value.getSourceLocation());
        }
    }
}
