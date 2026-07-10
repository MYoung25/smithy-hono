package com.smithyhono.traits;

import software.amazon.smithy.model.node.ArrayNode;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.AbstractTrait;
import software.amazon.smithy.model.traits.AbstractTraitBuilder;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * One or more MCP prompts (Plan 14, §12) declared on a {@code service} (service-wide
 * prompts) or an {@code operation} (operation-anchored prompts). The trait value is a
 * LIST of prompt structures — a Smithy shape carries only one instance of a trait, so the
 * list member is the idiomatic way to express N prompts on one shape (mirroring how
 * {@code @persisted.indexes} is a list).
 *
 * <pre>
 * &#64;mcpPrompts([
 *   { name: "triage-tasks", description: "…", arguments: [{ name: "focus" }], template: "… {focus}" }
 * ])
 * </pre>
 *
 * <p>The emitter ({@code McpManifestEmitter}) resolves each prompt into an
 * {@code MCP_PROMPTS} entry; on an operation it can default the {@code name}, derive
 * {@code arguments} from the op's input members, and reference the op's generated tool.
 * {@code ID = com.smithyhono#mcpPrompts}.
 */
public final class McpPromptsTrait extends AbstractTrait
        implements software.amazon.smithy.utils.ToSmithyBuilder<McpPromptsTrait> {

    public static final ShapeId ID = ShapeId.from("com.smithyhono#mcpPrompts");

    private final List<Prompt> prompts;

    private McpPromptsTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.prompts = List.copyOf(builder.prompts);
    }

    /** The declared prompts, in authored order. */
    public List<Prompt> getPrompts() { return prompts; }

    @Override
    protected Node createNode() {
        return Node.fromNodes(prompts.stream().map(Prompt::toNode).collect(Collectors.toList()))
            .toBuilder().sourceLocation(getSourceLocation()).build();
    }

    @Override
    public Builder toBuilder() {
        return builder().sourceLocation(getSourceLocation()).prompts(prompts);
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<McpPromptsTrait, Builder> {
        private List<Prompt> prompts = new ArrayList<>();

        public Builder prompts(List<Prompt> prompts) {
            this.prompts = new ArrayList<>(prompts);
            return this;
        }

        @Override
        public McpPromptsTrait build() { return new McpPromptsTrait(this); }
    }

    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public McpPromptsTrait createTrait(ShapeId target, Node value) {
            ArrayNode arr = value.expectArrayNode();
            Builder builder = builder().sourceLocation(value.getSourceLocation());
            List<Prompt> parsed = new ArrayList<>();
            for (Node element : arr.getElements()) {
                parsed.add(Prompt.fromNode(element.expectObjectNode()));
            }
            return builder.prompts(parsed).build();
        }
    }

    /** A single declared prompt: {@code { name?, description?, arguments?, template }}. */
    public static final class Prompt {
        private final String name;
        private final String description;
        private final List<Argument> arguments;
        private final boolean argumentsDeclared;
        private final String template;

        public Prompt(String name, String description, List<Argument> arguments,
                      boolean argumentsDeclared, String template) {
            this.name = name;
            this.description = description;
            this.arguments = List.copyOf(arguments);
            this.argumentsDeclared = argumentsDeclared;
            this.template = template;
        }

        /** Declared name; empty on an operation prompt that defaults to the op name. */
        public Optional<String> getName() { return Optional.ofNullable(name); }

        public Optional<String> getDescription() { return Optional.ofNullable(description); }

        /** The declared arguments (empty when {@code arguments} was omitted). */
        public List<Argument> getArguments() { return arguments; }

        /**
         * Whether {@code arguments} was present in the model at all. This is the
         * derive-with-override discriminator (§12.2): an OMITTED {@code arguments} on an
         * operation prompt triggers derivation, whereas an explicit (even empty) list is
         * authoritative.
         */
        public boolean isArgumentsDeclared() { return argumentsDeclared; }

        public String getTemplate() { return template; }

        static Prompt fromNode(ObjectNode node) {
            boolean argsDeclared = node.getMember("arguments").isPresent();
            List<Argument> args = new ArrayList<>();
            node.getArrayMember("arguments").ifPresent(arr -> {
                for (Node element : arr.getElements()) {
                    args.add(Argument.fromNode(element.expectObjectNode()));
                }
            });
            return new Prompt(
                node.getStringMember("name").map(n -> n.getValue()).orElse(null),
                node.getStringMember("description").map(n -> n.getValue()).orElse(null),
                args,
                argsDeclared,
                node.expectStringMember("template").getValue());
        }

        Node toNode() {
            ObjectNode.Builder b = Node.objectNodeBuilder();
            if (name != null) b.withMember("name", name);
            if (description != null) b.withMember("description", description);
            if (argumentsDeclared) {
                b.withMember("arguments", Node.fromNodes(
                    arguments.stream().map(Argument::toNode).collect(Collectors.toList())));
            }
            b.withMember("template", template);
            return b.build();
        }
    }

    /** A declared prompt argument: {@code { name, description?, required? }}. */
    public static final class Argument {
        private final String name;
        private final String description;
        private final boolean required;

        public Argument(String name, String description, boolean required) {
            this.name = name;
            this.description = description;
            this.required = required;
        }

        public String getName() { return name; }
        public Optional<String> getDescription() { return Optional.ofNullable(description); }
        public boolean isRequired() { return required; }

        static Argument fromNode(ObjectNode node) {
            return new Argument(
                node.expectStringMember("name").getValue(),
                node.getStringMember("description").map(n -> n.getValue()).orElse(null),
                node.getBooleanMember("required").map(n -> n.getValue()).orElse(false));
        }

        Node toNode() {
            ObjectNode.Builder b = Node.objectNodeBuilder().withMember("name", name);
            if (description != null) b.withMember("description", description);
            b.withMember("required", required);
            return b.build();
        }
    }
}
