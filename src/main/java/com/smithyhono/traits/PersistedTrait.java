package com.smithyhono.traits;

import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;
import software.amazon.smithy.model.traits.AbstractTraitBuilder;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Marks a {@code resource} shape as having a default DB-backed CRUD implementation
 * generated for it (Plan 13). The bare form {@code @persisted} applies all defaults;
 * the rich form carries storage config the resource shape itself can't express.
 *
 * <pre>
 * &#64;persisted                                  // bare = all defaults
 * &#64;persisted(table: "todos", softDelete: true, indexes: [{ name: "byOwner", key: "ownerId" }])
 * </pre>
 *
 * <p>Defaults: {@code timestamps=true}, {@code softDelete=false},
 * {@code optimisticConcurrency=false} (D5 seam present, enforcement off). {@code table}
 * defaults to the lowercased resource name when absent (resolved by the consumer, not
 * here). {@code ownerField}/{@code tenantField} are optional scoping keys.
 */
public final class PersistedTrait extends AbstractTrait
        implements software.amazon.smithy.utils.ToSmithyBuilder<PersistedTrait> {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#persisted");

    private final String table;
    private final boolean timestamps;
    private final boolean softDelete;
    private final boolean optimisticConcurrency;
    private final String ownerField;
    private final String tenantField;
    private final boolean allowUnscoped;
    private final List<Index> indexes;

    private PersistedTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.table = builder.table;
        this.timestamps = builder.timestamps;
        this.softDelete = builder.softDelete;
        this.optimisticConcurrency = builder.optimisticConcurrency;
        this.ownerField = builder.ownerField;
        this.tenantField = builder.tenantField;
        this.allowUnscoped = builder.allowUnscoped;
        this.indexes = List.copyOf(builder.indexes);
    }

    /** Collection / key-prefix; empty = default to the lowercased resource name. */
    public Optional<String> getTable() { return Optional.ofNullable(table); }

    /** Auto-manage createdAt/updatedAt iff the entity declares them. Default true. */
    public boolean isTimestamps() { return timestamps; }

    /** Tombstone instead of hard delete (adds deletedAt). Default false. */
    public boolean isSoftDelete() { return softDelete; }

    /** Version-guarded writes + 409 (D5 seam; default OFF). */
    public boolean isOptimisticConcurrency() { return optimisticConcurrency; }

    /** Owner scoping field, auto-injected from {@code principal.id}. */
    public Optional<String> getOwnerField() { return Optional.ofNullable(ownerField); }

    /** Tenant scoping field, auto-injected from {@code principal.tenantId} (AUTHZ-07). */
    public Optional<String> getTenantField() { return Optional.ofNullable(tenantField); }

    /**
     * Explicit, auditable opt-out marking the resource as intentionally single-tenant/public.
     * Default false. When true, both the {@code PersistedResource.UnscopedIdor} advisory and
     * {@code enforceResourceScoping} strict enforcement are suppressed for this resource.
     */
    public boolean isAllowUnscoped() { return allowUnscoped; }

    /** Declared secondary indexes for filtered list queries. */
    public List<Index> getIndexes() { return indexes; }

    @Override
    protected Node createNode() {
        ObjectNode.Builder node = Node.objectNodeBuilder()
            .sourceLocation(getSourceLocation())
            .withMember("timestamps", timestamps)
            .withMember("softDelete", softDelete)
            .withMember("optimisticConcurrency", optimisticConcurrency);
        node.withOptionalMember("table", getTable().map(Node::from));
        node.withOptionalMember("ownerField", getOwnerField().map(Node::from));
        node.withOptionalMember("tenantField", getTenantField().map(Node::from));
        // Only serialize when set — keeps the node byte-identical for the (default) absent case.
        if (allowUnscoped) {
            node.withMember("allowUnscoped", true);
        }
        if (!indexes.isEmpty()) {
            node.withMember("indexes", Node.fromNodes(
                indexes.stream().map(Index::toNode).collect(java.util.stream.Collectors.toList())));
        }
        return node.build();
    }

    @Override
    public Builder toBuilder() {
        return builder()
            .sourceLocation(getSourceLocation())
            .table(table)
            .timestamps(timestamps)
            .softDelete(softDelete)
            .optimisticConcurrency(optimisticConcurrency)
            .ownerField(ownerField)
            .tenantField(tenantField)
            .allowUnscoped(allowUnscoped)
            .indexes(indexes);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<PersistedTrait, Builder> {
        private String table;
        private boolean timestamps = true;
        private boolean softDelete = false;
        private boolean optimisticConcurrency = false;
        private String ownerField;
        private String tenantField;
        private boolean allowUnscoped = false;
        private List<Index> indexes = new ArrayList<>();

        public Builder table(String table) { this.table = table; return this; }
        public Builder timestamps(boolean timestamps) { this.timestamps = timestamps; return this; }
        public Builder softDelete(boolean softDelete) { this.softDelete = softDelete; return this; }
        public Builder optimisticConcurrency(boolean v) { this.optimisticConcurrency = v; return this; }
        public Builder ownerField(String ownerField) { this.ownerField = ownerField; return this; }
        public Builder tenantField(String tenantField) { this.tenantField = tenantField; return this; }
        public Builder allowUnscoped(boolean allowUnscoped) { this.allowUnscoped = allowUnscoped; return this; }

        public Builder indexes(List<Index> indexes) {
            this.indexes = new ArrayList<>(indexes);
            return this;
        }

        @Override
        public PersistedTrait build() { return new PersistedTrait(this); }
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public PersistedTrait createTrait(ShapeId target, Node value) {
            ObjectNode node = value.expectObjectNode();
            Builder builder = builder().sourceLocation(value.getSourceLocation());
            node.getStringMember("table").ifPresent(n -> builder.table(n.getValue()));
            node.getBooleanMember("timestamps").ifPresent(n -> builder.timestamps(n.getValue()));
            node.getBooleanMember("softDelete").ifPresent(n -> builder.softDelete(n.getValue()));
            node.getBooleanMember("optimisticConcurrency")
                .ifPresent(n -> builder.optimisticConcurrency(n.getValue()));
            node.getStringMember("ownerField").ifPresent(n -> builder.ownerField(n.getValue()));
            node.getStringMember("tenantField").ifPresent(n -> builder.tenantField(n.getValue()));
            node.getBooleanMember("allowUnscoped").ifPresent(n -> builder.allowUnscoped(n.getValue()));
            node.getArrayMember("indexes").ifPresent(arr -> {
                List<Index> parsed = new ArrayList<>();
                for (Node element : arr.getElements()) {
                    parsed.add(Index.fromNode(element.expectObjectNode()));
                }
                builder.indexes(parsed);
            });
            return builder.build();
        }
    }

    /** A declared secondary index: {@code { name, key }}. */
    public static final class Index {
        private final String name;
        private final String key;

        public Index(String name, String key) {
            this.name = name;
            this.key = key;
        }

        public String getName() { return name; }
        public String getKey() { return key; }

        static Index fromNode(ObjectNode node) {
            return new Index(
                node.expectStringMember("name").getValue(),
                node.expectStringMember("key").getValue());
        }

        Node toNode() {
            return Node.objectNodeBuilder()
                .withMember("name", name)
                .withMember("key", key)
                .build();
        }
    }
}
