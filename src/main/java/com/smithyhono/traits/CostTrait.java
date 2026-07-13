package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;
import software.amazon.smithy.model.traits.AbstractTraitBuilder;

/**
 * Relative cost of an operation, used by the runtime rate limiter (RATE-07).
 * Defaults to 1 when the trait is absent.
 *
 * <pre>@cost(value: 5)</pre>
 */
public final class CostTrait extends AbstractTrait
        implements software.amazon.smithy.utils.ToSmithyBuilder<CostTrait> {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#cost");

    private final int value;

    private CostTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.value = builder.value;
    }

    public int getValue() {
        return value;
    }

    @Override
    protected Node createNode() {
        return Node.objectNodeBuilder()
            .sourceLocation(getSourceLocation())
            .withMember("value", value)
            .build();
    }

    @Override
    public Builder toBuilder() {
        return builder().sourceLocation(getSourceLocation()).value(value);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<CostTrait, Builder> {
        private int value = 1;

        public Builder value(int value) {
            this.value = value;
            return this;
        }

        @Override
        public CostTrait build() { return new CostTrait(this); }
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public CostTrait createTrait(ShapeId target, Node value) {
            ObjectNode node = value.expectObjectNode();
            Builder builder = builder().sourceLocation(value.getSourceLocation());
            builder.value(node.expectNumberMember("value").getValue().intValue());
            return builder.build();
        }
    }
}
