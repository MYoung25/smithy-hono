package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;
import software.amazon.smithy.model.traits.AbstractTraitBuilder;

import java.util.Optional;

/**
 * Marks a {@code @persisted} resource as realtime-observable (Phase L1). Generates a
 * functional SSE subscribe endpoint keyed by the resource id and wires notify-on-commit
 * so a successful write pushes a {@code { id, version }} notification to that key's
 * subscribers. The store's monotonic {@code version} is the reconcile cursor; clients
 * refetch on a newer version. The backend (polling vs Durable Object push) is a
 * deploy-time choice — the generated code targets the {@code @smithy-hono/realtime}
 * {@code RealtimeHub} port, not a specific backend.
 *
 * <pre>
 * &#64;live                                   // bare = all defaults
 * &#64;live(eventType: "game:moved", lifecycleEvents: true)
 * </pre>
 *
 * <p>Defaults: {@code keyMember} = the resource identifier member (the DataStore key);
 * {@code eventType} = {@code "<lowercasedResource>:updated"}; {@code lifecycleEvents}
 * = false; {@code pushRecords} = false.
 */
public final class LiveTrait extends AbstractTrait
        implements software.amazon.smithy.utils.ToSmithyBuilder<LiveTrait> {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#live");

    private final String keyMember;
    private final String eventType;
    private final boolean lifecycleEvents;
    private final boolean pushRecords;

    private LiveTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.keyMember = builder.keyMember;
        this.eventType = builder.eventType;
        this.lifecycleEvents = builder.lifecycleEvents;
        this.pushRecords = builder.pushRecords;
    }

    /** Channel-key member; empty = default to the resource identifier member. */
    public Optional<String> getKeyMember() { return Optional.ofNullable(keyMember); }

    /** Event {@code type} emitted on commit; empty = default {@code "<resource>:updated"}. */
    public Optional<String> getEventType() { return Optional.ofNullable(eventType); }

    /** Also emit created/deleted lifecycle events in addition to updated. Default false. */
    public boolean isLifecycleEvents() { return lifecycleEvents; }

    /** Emit {@code {records, version}} frames instead of {@code {id, version}} hints. Default false. */
    public boolean isPushRecords() { return pushRecords; }

    @Override
    protected Node createNode() {
        ObjectNode.Builder node = Node.objectNodeBuilder()
            .sourceLocation(getSourceLocation());
        node.withOptionalMember("keyMember", getKeyMember().map(Node::from));
        node.withOptionalMember("eventType", getEventType().map(Node::from));
        // Only serialize the booleans when set — keeps the node byte-identical for the
        // (default) absent case, matching PersistedTrait's allowUnscoped treatment.
        if (lifecycleEvents) node.withMember("lifecycleEvents", true);
        if (pushRecords) node.withMember("pushRecords", true);
        return node.build();
    }

    @Override
    public Builder toBuilder() {
        return builder()
            .sourceLocation(getSourceLocation())
            .keyMember(keyMember)
            .eventType(eventType)
            .lifecycleEvents(lifecycleEvents)
            .pushRecords(pushRecords);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<LiveTrait, Builder> {
        private String keyMember;
        private String eventType;
        private boolean lifecycleEvents = false;
        private boolean pushRecords = false;

        public Builder keyMember(String keyMember) { this.keyMember = keyMember; return this; }
        public Builder eventType(String eventType) { this.eventType = eventType; return this; }
        public Builder lifecycleEvents(boolean v) { this.lifecycleEvents = v; return this; }
        public Builder pushRecords(boolean v) { this.pushRecords = v; return this; }

        @Override
        public LiveTrait build() { return new LiveTrait(this); }
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public LiveTrait createTrait(ShapeId target, Node value) {
            ObjectNode node = value.expectObjectNode();
            Builder builder = builder().sourceLocation(value.getSourceLocation());
            node.getStringMember("keyMember").ifPresent(n -> builder.keyMember(n.getValue()));
            node.getStringMember("eventType").ifPresent(n -> builder.eventType(n.getValue()));
            node.getBooleanMember("lifecycleEvents").ifPresent(n -> builder.lifecycleEvents(n.getValue()));
            node.getBooleanMember("pushRecords").ifPresent(n -> builder.pushRecords(n.getValue()));
            return builder.build();
        }
    }
}
