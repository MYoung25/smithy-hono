package com.smithyhono;

import com.smithyhono.traits.CostTrait;
import com.smithyhono.traits.McpPromptsTrait;
import com.smithyhono.traits.PersistedTrait;
import com.smithyhono.traits.RequiresAuthTrait;
import com.smithyhono.traits.Sigv4HmacTrait;
import com.smithyhono.traits.SseStreamTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.ServiceIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.*;

import java.util.*;
import java.util.stream.Collectors;

public class ModelIndex {
    private static final java.util.logging.Logger LOGGER =
        java.util.logging.Logger.getLogger(ModelIndex.class.getName());

    private final Model model;
    private final ServiceShape service;
    private final List<OperationShape> operations;
    private final Set<ShapeId> emittedSchemas = new HashSet<>();

    public ModelIndex(Model model, ShapeId serviceId) {
        this.model = model;
        this.service = model.expectShape(serviceId, ServiceShape.class);
        this.operations = new ArrayList<>(TopDownIndex.of(model).getContainedOperations(service));
        this.operations.sort(Comparator.comparing(s -> s.getId().getName()));
    }

    public ServiceShape getService() { return service; }
    public List<OperationShape> getOperations() { return operations; }

    public Optional<StructureShape> getInput(OperationShape op) {
        return op.getInput().flatMap(id -> model.getShape(id).flatMap(Shape::asStructureShape));
    }

    public Optional<StructureShape> getOutput(OperationShape op) {
        return op.getOutput().flatMap(id -> model.getShape(id).flatMap(Shape::asStructureShape));
    }

    /**
     * The operation's {@code @documentation} text, if any. Surfaced into the
     * registry (and thus MCP tool descriptions) — an MCP tool's description is what
     * an LLM reads to decide whether to call it.
     */
    public Optional<String> documentationFor(OperationShape op) {
        return op.getTrait(software.amazon.smithy.model.traits.DocumentationTrait.class)
            .map(software.amazon.smithy.model.traits.DocumentationTrait::getValue);
    }

    /**
     * Dot-paths of every {@code @sensitive} member reachable from the operation's
     * input/output (RT-13). A member is sensitive if the member OR its target shape
     * carries {@code @sensitive}. Nested structures are walked (with a cycle guard),
     * so a field at {@code body.password} is reported as {@code "body.password"}. The
     * runtime logging/audit layer uses these to scrub model-derived data.
     */
    public List<String> sensitiveFieldPaths(OperationShape op) {
        Set<String> out = new LinkedHashSet<>();
        getInput(op).ifPresent(s -> collectSensitive(s, "", out, new HashSet<>()));
        getOutput(op).ifPresent(s -> collectSensitive(s, "", out, new HashSet<>()));
        return new ArrayList<>(out);
    }

    private void collectSensitive(StructureShape struct, String prefix, Set<String> out, Set<ShapeId> seen) {
        if (!seen.add(struct.getId())) return;
        for (Map.Entry<String, MemberShape> e : struct.getAllMembers().entrySet()) {
            MemberShape m = e.getValue();
            Shape target = model.expectShape(m.getTarget());
            String path = prefix.isEmpty() ? e.getKey() : prefix + "." + e.getKey();
            if (m.hasTrait(SensitiveTrait.class) || target.hasTrait(SensitiveTrait.class)) {
                out.add(path);
            }
            target.asStructureShape().ifPresent(ts -> collectSensitive(ts, path, out, seen));
        }
    }

    public List<StructureShape> getErrors(OperationShape op) {
        return op.getErrors(service).stream()
            .map(id -> model.expectShape(id, StructureShape.class))
            .collect(Collectors.toList());
    }

    /** Service-level errors first, then operation-level errors, deduped. */
    public List<StructureShape> getAllErrors(OperationShape op) {
        Set<ShapeId> seen = new LinkedHashSet<>();
        List<StructureShape> errors = new ArrayList<>();
        for (ShapeId errorId : service.getErrors()) {
            if (seen.add(errorId)) errors.add(model.expectShape(errorId, StructureShape.class));
        }
        for (StructureShape error : getErrors(op)) {
            if (seen.add(error.getId())) errors.add(error);
        }
        return errors;
    }

    public List<StructureShape> getServiceErrors() {
        return service.getErrors().stream()
            .map(id -> model.expectShape(id, StructureShape.class))
            .collect(Collectors.toList());
    }

    public Shape resolveTarget(MemberShape member) {
        return model.expectShape(member.getTarget());
    }

    public boolean shouldEmit(ShapeId id) {
        return emittedSchemas.add(id);
    }

    public boolean isRecursive(ShapeId id) {
        return isRecursive(id, new HashSet<>());
    }

    private boolean isRecursive(ShapeId id, Set<ShapeId> visited) {
        if (!visited.add(id)) return true;
        Shape shape = model.expectShape(id);
        for (ShapeId memberId : shape.members().stream()
                .map(MemberShape::getTarget).collect(Collectors.toList())) {
            if (isRecursive(memberId, visited)) return true;
        }
        visited.remove(id);
        return false;
    }

    // ── Metadata registry helpers (Phase S1) ──────────────────────────────────

    /** The set of AuthScheme `type` strings ('oidc' | 'sigv4Hmac' | 'anonymous') for an op. */
    public List<String> authSchemesFor(OperationShape op) {
        // Explicit opt-out: anonymous (AUTH-01). @optionalAuth (and no positive auth) -> anonymous.
        boolean optionalAuth = op.hasTrait(OptionalAuthTrait.class);

        LinkedHashSet<String> schemes = new LinkedHashSet<>();

        // Smithy-modeled effective auth schemes (e.g. @httpBearerAuth on the service / @auth on the op).
        Map<ShapeId, Trait> effective = ServiceIndex.of(model)
            .getEffectiveAuthSchemes(service, op);
        for (ShapeId schemeId : effective.keySet()) {
            String mapped = mapAuthScheme(schemeId);
            if (mapped != null) schemes.add(mapped);
        }

        // Custom S2S signing marker maps to sigv4Hmac.
        if (op.hasTrait(Sigv4HmacTrait.class)) schemes.add("sigv4Hmac");

        // @requiresAuth implies an authenticated (OIDC, browser) caller when no
        // Smithy scheme was modeled.
        if (op.hasTrait(RequiresAuthTrait.class) && schemes.isEmpty()) schemes.add("oidc");

        if (schemes.isEmpty()) {
            return optionalAuth ? List.of("anonymous") : List.of();
        }
        return new ArrayList<>(schemes);
    }

    private String mapAuthScheme(ShapeId schemeId) {
        String name = schemeId.toString();
        if (name.equals(HttpBearerAuthTrait.ID.toString())) return "oidc";
        if (name.equals(Sigv4HmacTrait.ID.toString())) return "sigv4Hmac";
        if (name.equals("smithy.api#noAuth")) return "anonymous";
        // Other modeled schemes (apiKey/basic/digest) are treated as browser/OIDC-equivalent.
        return "oidc";
    }

    /** Relative cost for the rate limiter; defaults to 1 when @cost is absent. */
    public int costFor(OperationShape op) {
        return op.getTrait(CostTrait.class).map(CostTrait::getValue).orElse(1);
    }

    /** True if the operation carries any positive auth declaration (AUTH-02). */
    public boolean hasAuthDeclaration(OperationShape op) {
        if (op.hasTrait(RequiresAuthTrait.class)) return true;
        if (op.hasTrait(AuthTrait.class)) return true;
        if (op.hasTrait(OptionalAuthTrait.class)) return true;
        if (op.hasTrait(Sigv4HmacTrait.class)) return true;
        // A non-empty effective set from service-level schemes also counts.
        return !ServiceIndex.of(model).getEffectiveAuthSchemes(service, op).isEmpty();
    }

    public boolean isReadonly(OperationShape op) {
        return op.hasTrait(ReadonlyTrait.class);
    }

    public boolean isStreaming(OperationShape op) {
        return op.hasTrait(SseStreamTrait.class);
    }

    public Optional<String> requiredPermissionFor(OperationShape op) {
        if (!op.hasTrait(RequiresAuthTrait.class)) return Optional.empty();
        return op.expectTrait(RequiresAuthTrait.class).getPermission()
            .filter(p -> !p.isEmpty());
    }

    /**
     * Pagination metadata for a {@code @paginated} operation, or empty (RATE-06).
     *
     * <p>The cap is derived from the model, not hardcoded: the {@code @paginated}
     * trait names the page-size input member, and the cap lives on that member as a
     * {@code @range(max:)} constraint (the same constraint VAL-01 wants pervasively).
     * The default page size comes from {@code @default} on the member. When a
     * {@code @paginated} operation declares no {@code @range(max:)} cap, RATE-06 still
     * requires one, so we fall back to the supplied defaults and warn the modeler.
     */
    public Optional<Pagination> paginationFor(OperationShape op, int fallbackMax, int fallbackDefault) {
        if (!op.hasTrait(PaginatedTrait.class)) return Optional.empty();

        // Resolve the page-size member name: operation-level @paginated, then the
        // service-level @paginated defaults it may inherit.
        Optional<String> pageSizeMember = op.getTrait(PaginatedTrait.class)
            .flatMap(PaginatedTrait::getPageSize);
        if (pageSizeMember.isEmpty()) {
            pageSizeMember = service.getTrait(PaginatedTrait.class).flatMap(PaginatedTrait::getPageSize);
        }

        Optional<MemberShape> member = pageSizeMember.flatMap(name ->
            getInput(op).map(in -> in.getAllMembers().get(name)).filter(Objects::nonNull));

        Optional<Integer> explicitMax = member.flatMap(this::rangeMax);
        Optional<Integer> explicitDefault = member.flatMap(this::defaultInt);

        if (explicitMax.isEmpty()) {
            LOGGER.warning(String.format(
                "Paginated operation %s declares no max page size (RATE-06). Add @range(max:) "
                + "to its '%s' page-size member; falling back to %d.",
                op.getId().getName(), pageSizeMember.orElse("<unset>"), fallbackMax));
        }

        int max = explicitMax.orElse(fallbackMax);
        int def = Math.min(explicitDefault.orElse(fallbackDefault), max); // never exceed the cap
        return Optional.of(new Pagination(max, def));
    }

    /** @range max on the member, or its target shape, as an int. */
    private Optional<Integer> rangeMax(MemberShape m) {
        Optional<RangeTrait> range = m.getTrait(RangeTrait.class);
        if (range.isEmpty()) {
            range = model.getShape(m.getTarget()).flatMap(s -> s.getTrait(RangeTrait.class));
        }
        return range.flatMap(RangeTrait::getMax).map(java.math.BigDecimal::intValue);
    }

    /** @default numeric value on the member, as an int. */
    private Optional<Integer> defaultInt(MemberShape m) {
        return m.getTrait(DefaultTrait.class)
            .map(DefaultTrait::toNode)
            .filter(software.amazon.smithy.model.node.Node::isNumberNode)
            .map(n -> n.expectNumberNode().getValue().intValue());
    }

    /** Pagination caps surfaced into the registry. */
    public static final class Pagination {
        public final int maxPageSize;
        public final int defaultPageSize;

        public Pagination(int maxPageSize, int defaultPageSize) {
            this.maxPageSize = maxPageSize;
            this.defaultPageSize = defaultPageSize;
        }
    }

    /**
     * True if any member of the operation's input (recursively, one level into
     * targets) carries a constraint trait — used for the registry VAL summary.
     */
    public boolean hasConstrainedInput(OperationShape op) {
        return getInput(op)
            .map(input -> structHasConstraint(input, new HashSet<>()))
            .orElse(false);
    }

    private boolean structHasConstraint(StructureShape struct, Set<ShapeId> visited) {
        if (!visited.add(struct.getId())) return false;
        for (MemberShape member : struct.getAllMembers().values()) {
            if (memberOrTargetConstrained(member, visited)) return true;
        }
        return false;
    }

    private boolean memberOrTargetConstrained(MemberShape member, Set<ShapeId> visited) {
        if (isConstrained(member)) return true;
        Shape target = model.expectShape(member.getTarget());
        if (isConstrained(target)) return true;
        if (target instanceof StructureShape nested) {
            return structHasConstraint(nested, visited);
        }
        if (target instanceof ListShape list) {
            return memberOrTargetConstrained(list.getMember(), visited);
        }
        return false;
    }

    private boolean isConstrained(Shape shape) {
        return shape.hasTrait(LengthTrait.class)
            || shape.hasTrait(RangeTrait.class)
            || shape.hasTrait(PatternTrait.class)
            || shape.hasTrait(UniqueItemsTrait.class)
            || shape.isEnumShape()
            || shape.isIntEnumShape();
    }

    public String smithyUriToHono(String smithyUri) {
        return smithyUri
            .replaceAll("\\{(\\w+)\\}", ":$1")
            .replaceAll("\\{\\+(\\w+)\\}", ":$1{*}");
    }

    public String toRouterVarName(ServiceShape svc) {
        String name = svc.getId().getName()
            .replace("Service", "")
            .replace("service", "");
        return Character.toLowerCase(name.charAt(0)) + name.substring(1);
    }

    public String toOperationsInterfaceName(ServiceShape svc) {
        return svc.getId().getName().replace("Service", "") + "Operations";
    }

    // ── Persisted resource resolution (Plan 13, P2) ───────────────────────────

    /** The CRUD lifecycle verbs a {@code resource} shape can bind (Plan 13). */
    public enum CrudVerb { CREATE, PUT, READ, UPDATE, DELETE, LIST }

    /**
     * Resources in this service carrying {@code @persisted}, sorted by name. Only
     * these resources get a default DB-backed CRUD implementation; everything else
     * is unaffected.
     */
    public List<ResourceShape> persistedResources() {
        return service.getResources().stream()
            .map(id -> model.expectShape(id, ResourceShape.class))
            .filter(r -> r.hasTrait(PersistedTrait.class))
            .sorted(Comparator.comparing(r -> r.getId().getName()))
            .collect(Collectors.toList());
    }

    /**
     * The lifecycle operations bound by a resource, keyed by CRUD verb, derived
     * from Smithy's native lifecycle bindings ({@code getCreate/getPut/getRead/
     * getUpdate/getDelete/getList}). Custom instance/collection operations are NOT
     * included — the default factory only covers the lifecycle subset.
     */
    public Map<CrudVerb, OperationShape> lifecycleOps(ResourceShape resource) {
        Map<CrudVerb, OperationShape> ops = new EnumMap<>(CrudVerb.class);
        resource.getCreate().ifPresent(id -> ops.put(CrudVerb.CREATE, opShape(id)));
        resource.getPut().ifPresent(id -> ops.put(CrudVerb.PUT, opShape(id)));
        resource.getRead().ifPresent(id -> ops.put(CrudVerb.READ, opShape(id)));
        resource.getUpdate().ifPresent(id -> ops.put(CrudVerb.UPDATE, opShape(id)));
        resource.getDelete().ifPresent(id -> ops.put(CrudVerb.DELETE, opShape(id)));
        resource.getList().ifPresent(id -> ops.put(CrudVerb.LIST, opShape(id)));
        return ops;
    }

    private OperationShape opShape(ShapeId id) {
        return model.expectShape(id, OperationShape.class);
    }

    /** The resource's identifier member names ({@code resource.getIdentifiers()}). */
    public List<String> identifierMembers(ResourceShape resource) {
        return new ArrayList<>(resource.getIdentifiers().keySet());
    }

    /**
     * The entity shape backing a persisted resource, per Plan 13's
     * "Entity &amp; output-wrapper derivation rule": the target shape of the SOLE
     * member of the {@code read} op's output structure (e.g. {@code GetTodoOutput
     * { item: Todo }} → {@code Todo}). Empty when there is no {@code read} op, no
     * output, or the output is not a single-member wrapper structure (the caller
     * then falls back to interface-only generation).
     */
    public Optional<Shape> entityShape(ResourceShape resource) {
        OperationShape read = lifecycleOps(resource).get(CrudVerb.READ);
        if (read == null) return Optional.empty();
        return getOutput(read)
            .filter(out -> out.getAllMembers().size() == 1)
            .map(out -> out.getAllMembers().values().iterator().next())
            .map(this::resolveTarget);
    }

    /** The resolved {@code @persisted} config for a resource (defaults applied). */
    public PersistedTrait persistedConfig(ResourceShape resource) {
        return resource.expectTrait(PersistedTrait.class);
    }

    // ── Realtime resource resolution (Phase L1) ────────────────────────────────

    /**
     * Resources in this service carrying {@code @live}, sorted by name. Only these
     * resources get a generated realtime SSE subscribe router + notify wiring; every
     * other resource is unaffected. {@code @live}'s selector requires {@code @persisted},
     * so each of these is also a persisted resource.
     */
    public List<ResourceShape> liveResources() {
        return service.getResources().stream()
            .map(id -> model.expectShape(id, ResourceShape.class))
            .filter(r -> r.hasTrait(com.smithyhono.traits.LiveTrait.class))
            .sorted(Comparator.comparing(r -> r.getId().getName()))
            .collect(Collectors.toList());
    }

    /** The resolved {@code @live} config for a resource (defaults applied). */
    public com.smithyhono.traits.LiveTrait liveConfig(ResourceShape resource) {
        return resource.expectTrait(com.smithyhono.traits.LiveTrait.class);
    }

    /**
     * The CRUD lifecycle metadata for an operation, when it is a lifecycle binding of a
     * {@code @persisted} resource in this service (Plan 13, P3 registry additions). Empty
     * for non-lifecycle ops and ops on non-persisted resources. Used by the registry
     * emitter to surface {@code resource}/{@code crudVerb}/{@code identifierMembers}.
     */
    public Optional<CrudMeta> crudMetaFor(OperationShape op) {
        for (ResourceShape resource : persistedResources()) {
            for (Map.Entry<CrudVerb, OperationShape> e : lifecycleOps(resource).entrySet()) {
                if (e.getValue().getId().equals(op.getId())) {
                    return Optional.of(new CrudMeta(
                        resource.getId().getName(), e.getKey(), identifierMembers(resource)));
                }
            }
        }
        return Optional.empty();
    }

    /** Registry-surfaced CRUD metadata for a persisted-resource lifecycle op. */
    public static final class CrudMeta {
        public final String resource;
        public final CrudVerb verb;
        public final List<String> identifierMembers;

        public CrudMeta(String resource, CrudVerb verb, List<String> identifierMembers) {
            this.resource = resource;
            this.verb = verb;
            this.identifierMembers = identifierMembers;
        }
    }

    // ── MCP prompts (Plan 14, §12) ────────────────────────────────────────────

    /**
     * The {@code @mcpPrompts} declared on the service itself (service-wide prompts), in
     * authored order. Empty when the service carries no {@code @mcpPrompts}. Service-level
     * prompts have no anchoring operation, so the emitter does NOT default their name or
     * derive their arguments — they are exactly what's declared.
     */
    public List<McpPromptsTrait.Prompt> servicePrompts() {
        return service.getTrait(McpPromptsTrait.class)
            .map(McpPromptsTrait::getPrompts)
            .orElse(List.of());
    }

    /**
     * The {@code @mcpPrompts} declared on an operation (operation-anchored prompts), in
     * authored order. Empty when the op carries no {@code @mcpPrompts}. The emitter
     * defaults each prompt's name to {@code kebab(op.name)}, references the op's generated
     * tool in the description, and — when {@code arguments} is omitted — derives the args
     * from the op's input members ({@link #derivePromptArguments}).
     */
    public List<McpPromptsTrait.Prompt> promptsFor(OperationShape op) {
        return op.getTrait(McpPromptsTrait.class)
            .map(McpPromptsTrait::getPrompts)
            .orElse(List.of());
    }

    /**
     * Derives prompt arguments from an operation's TOP-LEVEL input members (§12.2 input
     * member → prompt argument mapping). Used by BOTH the emitter (to fill an omitted
     * {@code arguments}) and the validator (to know which placeholders an op-anchored
     * prompt with omitted {@code arguments} may legally reference) — so both read the same
     * single source.
     *
     * <ul>
     *   <li>{@code name} = the input member name (the flat tool-arg shape, e.g. {@code body},
     *       {@code id}). Nested object members are NOT flattened in MVP.</li>
     *   <li>{@code description} = the member's {@code @documentation} (absent → none).</li>
     *   <li>{@code required} = the member carries {@code @required}.</li>
     * </ul>
     */
    public List<DerivedPromptArgument> derivePromptArguments(OperationShape op) {
        List<DerivedPromptArgument> args = new ArrayList<>();
        getInput(op).ifPresent(input -> {
            for (Map.Entry<String, MemberShape> e : input.getAllMembers().entrySet()) {
                MemberShape member = e.getValue();
                String desc = member.getTrait(DocumentationTrait.class)
                    .map(DocumentationTrait::getValue).orElse(null);
                boolean required = member.hasTrait(RequiredTrait.class);
                args.add(new DerivedPromptArgument(e.getKey(), desc, required));
            }
        });
        return args;
    }

    /** A prompt argument derived from an input member (§12.2). */
    public static final class DerivedPromptArgument {
        public final String name;
        public final String description; // nullable
        public final boolean required;

        public DerivedPromptArgument(String name, String description, boolean required) {
            this.name = name;
            this.description = description;
            this.required = required;
        }
    }

    /** Build a human-readable debug summary of the whole model index. */
    public String buildDebugSummary() {
        StringBuilder sb = new StringBuilder();
        sb.append("// ModelIndex debug summary\n");
        sb.append("// service: ").append(service.getId()).append("\n");
        sb.append("// routerVar: ").append(toRouterVarName(service)).append("\n");
        sb.append("// operationsInterface: ").append(toOperationsInterfaceName(service)).append("\n");
        sb.append("// operations: ").append(operations.size()).append("\n\n");

        for (OperationShape op : operations) {
            sb.append("// --- ").append(op.getId().getName()).append(" ---\n");

            if (op.hasTrait(HttpTrait.class)) {
                HttpTrait http = op.expectTrait(HttpTrait.class);
                sb.append("//   http: ").append(http.getMethod())
                  .append(" ").append(http.getUri())
                  .append(" (").append(http.getCode()).append(")\n");
                sb.append("//   honoPath: ").append(smithyUriToHono(http.getUri().toString())).append("\n");
            }

            getInput(op).ifPresent(input -> {
                sb.append("//   input: ").append(input.getId().getName()).append("\n");
                appendMembers(sb, input, "    ");
            });

            getOutput(op).ifPresent(output -> {
                sb.append("//   output: ").append(output.getId().getName()).append("\n");
                appendMembers(sb, output, "    ");
            });

            List<StructureShape> errors = getErrors(op);
            if (!errors.isEmpty()) {
                sb.append("//   errors:\n");
                for (StructureShape err : errors) {
                    String fault = err.hasTrait(ErrorTrait.class)
                        ? err.expectTrait(ErrorTrait.class).getValue()
                        : "unknown";
                    sb.append("//     ").append(err.getId().getName())
                      .append(" (").append(fault).append(")\n");
                }
            }
        }

        return sb.toString();
    }

    private void appendMembers(StringBuilder sb, StructureShape struct, String indent) {
        for (Map.Entry<String, MemberShape> entry : struct.getAllMembers().entrySet()) {
            String memberName = entry.getKey();
            MemberShape member = entry.getValue();
            Shape target = resolveTarget(member);
            boolean required = member.hasTrait(RequiredTrait.class);

            String binding = "";
            if (member.hasTrait(HttpLabelTrait.class)) binding = " [@httpLabel]";
            else if (member.hasTrait(HttpQueryTrait.class)) binding = " [@httpQuery]";
            else if (member.hasTrait(HttpHeaderTrait.class)) binding = " [@httpHeader]";
            else if (member.hasTrait(HttpPayloadTrait.class)) binding = " [@httpPayload]";

            sb.append("//").append(indent)
              .append(memberName)
              .append(required ? "!" : "?")
              .append(": ")
              .append(target.getType())
              .append(binding)
              .append("\n");
        }
    }
}
