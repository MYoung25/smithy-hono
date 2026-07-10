package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;
import software.amazon.smithy.model.traits.AbstractTraitBuilder;

import java.util.Optional;

public final class RequiresAuthTrait extends AbstractTrait
        implements software.amazon.smithy.utils.ToSmithyBuilder<RequiresAuthTrait> {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#requiresAuth");

    private final String permission;

    private RequiresAuthTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.permission = builder.permission;
    }

    public Optional<String> getPermission() {
        return Optional.ofNullable(permission);
    }

    @Override
    protected Node createNode() {
        ObjectNode.Builder builder = Node.objectNodeBuilder();
        if (permission != null) builder.withMember("permission", permission);
        return builder.build();
    }

    @Override
    public Builder toBuilder() {
        return builder().permission(permission);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<RequiresAuthTrait, Builder> {
        private String permission;

        public Builder permission(String permission) {
            this.permission = permission;
            return this;
        }

        @Override
        public RequiresAuthTrait build() { return new RequiresAuthTrait(this); }
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public RequiresAuthTrait createTrait(ShapeId target, Node value) {
            ObjectNode node = value.expectObjectNode();
            Builder builder = builder().sourceLocation(value.getSourceLocation());
            node.getStringMember("permission").ifPresent(n -> builder.permission(n.getValue()));
            return builder.build();
        }
    }
}
