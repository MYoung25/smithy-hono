package com.smithyhono;

import com.smithyhono.writers.ClientEmitter;
import com.smithyhono.writers.CrudEmitter;
import com.smithyhono.writers.LiveEmitter;
import com.smithyhono.writers.McpManifestEmitter;
import com.smithyhono.writers.MetadataRegistryEmitter;
import com.smithyhono.writers.PermissionsEmitter;
import com.smithyhono.writers.RouteEmitter;
import com.smithyhono.writers.SchemaDeclarationEmitter;
import com.smithyhono.writers.SseEmitter;
import com.smithyhono.writers.TypeScriptFileWriter;
import com.smithyhono.writers.ZodEmitter;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.build.SmithyBuildPlugin;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.MixinTrait;

import java.util.*;
import java.util.stream.Collectors;

public class HonoCodegenPlugin implements SmithyBuildPlugin {

    @Override
    public String getName() {
        return "hono-codegen";
    }

    @Override
    public void execute(PluginContext context) {
        Model model = context.getModel();
        HonoSettings settings = HonoSettings.from(context.getSettings());
        ModelIndex index = new ModelIndex(model, settings.getService());

        RouteEmitter routeEmitter = new RouteEmitter(model, index);
        CrudEmitter crudEmitter =
            new CrudEmitter(model, index, settings.getSecurityCoreImport(),
                settings.getDefaultMaxPageSize(), settings.getDefaultPageSize(),
                settings.isEnforceResourceScoping());
        // Phase L1: realtime SSE router + notify wiring for @live resources. Gated — nothing
        // emits unless a resource carries @live. Reuses routeEmitter to gate the subscribe
        // route with the read op's authorize() (Phase L2).
        LiveEmitter liveEmitter =
            new LiveEmitter(model, index, routeEmitter, settings.getSecurityCoreImport(),
                settings.isEnforceResourceScoping());

        Map<String, List<OperationShape>> groups = groupOperationsByResource(model, index);

        // Plan 13 (P3): persisted resources keyed by their group name (= resource name), so
        // the per-group loop can emit the default CRUD factory alongside the route file.
        Map<String, ResourceShape> persistedByGroup = new LinkedHashMap<>();
        for (ResourceShape resource : index.persistedResources()) {
            persistedByGroup.put(resource.getId().getName(), resource);
        }

        // Pre-pass: compute schema roots and reachable shape IDs per resource group.
        Map<String, Set<StructureShape>> rootsPerGroup = new LinkedHashMap<>();
        Map<String, Set<ShapeId>> reachablePerGroup = new LinkedHashMap<>();
        for (Map.Entry<String, List<OperationShape>> entry : groups.entrySet()) {
            Set<StructureShape> roots = collectSchemaRoots(entry.getValue(), index);
            rootsPerGroup.put(entry.getKey(), roots);
            reachablePerGroup.put(entry.getKey(), SchemaDeclarationEmitter.computeReachable(model, roots));
        }

        // Shapes reachable from 2+ resource groups are emitted to shared.gen.ts.
        Set<ShapeId> sharedShapeIds = findSharedShapes(reachablePerGroup);
        List<String> exportableFiles = new ArrayList<>();
        if (!sharedShapeIds.isEmpty()) {
            emitSharedFile(sharedShapeIds, model, context);
            exportableFiles.add("shared.gen.ts");
        }

        // Error classes referenced by 2+ resource groups (service-level errors are bound to
        // every op, so they always qualify) are emitted ONCE in errors.gen.ts and imported by
        // each resource module — otherwise every X.gen.ts re-declares `export class NotFoundError`
        // and the barrel's `export *` collides (TS2308).
        Map<String, List<StructureShape>> errorsPerGroup = new LinkedHashMap<>();
        for (Map.Entry<String, List<OperationShape>> entry : groups.entrySet()) {
            errorsPerGroup.put(entry.getKey(), collectErrors(entry.getValue(), index));
        }
        Set<ShapeId> sharedErrorIds = findSharedErrors(errorsPerGroup);
        if (!sharedErrorIds.isEmpty()) {
            emitErrorsFile(sharedErrorIds, model, routeEmitter, context);
            exportableFiles.add("errors.gen.ts");
        }

        // SSE codegen — emits events.gen.ts and events.template.ts
        boolean hasSseEvents = new SseEmitter(model, index.getService()).emit(context.getFileManifest());
        if (hasSseEvents) {
            exportableFiles.add("events.gen.ts");
        }

        // Permissions codegen — emits permissions.gen.ts when any operation uses @requiresAuth
        boolean hasPermissions = new PermissionsEmitter().emit(groups.values(), context.getFileManifest());
        if (hasPermissions) {
            exportableFiles.add("permissions.gen.ts");
        }

        // Metadata registry (ARCH-06) — the keystone consumed by the runtime security
        // layer. Covers every HTTP operation in the service, independent of resource grouping.
        boolean hasRegistry =
            new MetadataRegistryEmitter(index, settings.getDefaultMaxPageSize(), settings.getDefaultPageSize())
                .emit(index.getOperations(), context.getFileManifest());
        if (hasRegistry) {
            exportableFiles.add("registry.gen.ts");
        }

        // MCP tool manifest (Plan 14) — pairs MCP_TOOLS with the registry + emitted Zod
        // schemas so @smithy-hono/mcp-core can serve the service over MCP. Emitted
        // whenever the registry is (i.e. there's ≥1 HTTP op).
        if (hasRegistry) {
            boolean hasMcp = new McpManifestEmitter(index, sharedShapeIds).emit(groups, context.getFileManifest());
            if (hasMcp) {
                exportableFiles.add("mcp.gen.ts");
            }
        }

        // FetchLike is shared by all generated clients; emitting it per client file collides in
        // the barrel's export * (TS2308). It's emitted once below into client-runtime.gen.ts.
        boolean clientEmitted = false;

        for (Map.Entry<String, List<OperationShape>> entry : groups.entrySet()) {
            String groupName = entry.getKey();
            List<OperationShape> ops = entry.getValue();

            String fileName               = toKebabCase(groupName) + ".gen.ts";
            String interfaceName          = groupName + "Operations";
            String routerFunctionName     = "create" + groupName + "Router";
            String middlewareInterfaceName = groupName + "Middleware";

            Set<StructureShape> schemaRoots = rootsPerGroup.get(groupName);
            List<StructureShape> errors     = errorsPerGroup.get(groupName);
            // Errors hoisted to errors.gen.ts (shared across groups) are imported, not redeclared;
            // only the group's own errors are emitted as classes in this file.
            List<StructureShape> localErrors = new ArrayList<>();
            List<StructureShape> importedErrors = new ArrayList<>();
            for (StructureShape e : errors) {
                if (sharedErrorIds.contains(e.getId())) importedErrors.add(e);
                else localErrors.add(e);
            }

            TypeScriptFileWriter writer = new TypeScriptFileWriter();

            boolean needsAuth = routeEmitter.hasAuthenticatedOps(ops);
            boolean needsAuthorize = hasRegistry && routeEmitter.hasAuthorizedOps(ops);
            String envType = needsAuth ? (groupName + "Env") : null;
            Set<ShapeId> groupReachable = reachablePerGroup.get(groupName);

            writer.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
            writer.blank();
            writer.line("import { Hono } from 'hono'");
            writer.line("import type { Context, MiddlewareHandler } from 'hono'");
            writer.line("import { zValidator } from '@hono/zod-validator'");
            writer.line("import { z } from 'zod'");
            // CG-06: a dynamic @httpResponseCode status is cast to Hono's status type.
            if (routeEmitter.hasDynamicStatusOps(ops)) {
                writer.line("import type { ContentfulStatusCode } from 'hono/utils/http-status'");
            }
            // Phase S2: op-tier authZ hook + the metadata registry it reads.
            if (needsAuthorize) {
                writer.line("import { authorize } from '" + settings.getSecurityCoreImport() + "'");
                writer.line("import { OPERATIONS } from './registry.gen'");
            }
            // The operations interface threads the Hono Context typed with SecurityEnv
            // (D6) so handlers can read the pipeline-resolved principal, so SecurityEnv is
            // always imported. When the Env type is emitted (needsAuth) it additionally
            // references SecurityVariables, the runtime pipeline's context shape (ARCH-07).
            if (needsAuth) {
                writer.line("import type { SecurityEnv, SecurityVariables } from '" + settings.getSecurityCoreImport() + "'");
            } else {
                writer.line("import type { SecurityEnv } from '" + settings.getSecurityCoreImport() + "'");
            }
            // Import any shared schemas/types used by this resource group.
            String sharedImport = buildSharedImport(groupReachable, sharedShapeIds, model);
            if (sharedImport != null) {
                writer.line(sharedImport);
            }
            // Import shared error CLASSES (value import — thrown/caught at runtime) from errors.gen.
            if (!importedErrors.isEmpty()) {
                List<String> names = importedErrors.stream()
                    .map(e -> e.getId().getName()).collect(Collectors.toList());
                writer.line("import { " + String.join(", ", names) + " } from './errors.gen'");
            }
            writer.blank();

            writer.comment("---- Schemas ----");
            writer.blank();
            SchemaDeclarationEmitter schemaEmitter = new SchemaDeclarationEmitter(model);
            schemaEmitter.exclude(sharedShapeIds);
            schemaEmitter.emitDeclarations(schemaRoots, writer);

            if (!localErrors.isEmpty()) {
                writer.comment("---- Errors ----");
                writer.blank();
                routeEmitter.emitErrorClasses(localErrors, writer);
            }

            writer.comment("---- Operations interface ----");
            writer.blank();
            routeEmitter.emitOperationsInterface(interfaceName, ops, writer);

            if (needsAuth) {
                writer.comment("---- Env type ----");
                writer.blank();
                routeEmitter.emitEnvType(envType, writer);
            }

            writer.comment("---- Middleware interface ----");
            writer.blank();
            routeEmitter.emitMiddlewareInterface(middlewareInterfaceName, ops, writer);

            writer.comment("---- Router factory ----");
            writer.blank();
            routeEmitter.emitRouterFactory(routerFunctionName, interfaceName, middlewareInterfaceName, ops, writer);

            writer.write(context.getFileManifest(), fileName);
            exportableFiles.add(fileName);

            // Typed fetch client (<stem>.client.gen.ts), emitted alongside the router so
            // the two share a wire contract by construction. Imports types + error classes
            // from this group's ./<stem>.gen (and ./shared.gen / ./errors.gen for shared shapes
            // and shared error classes), and FetchLike from the single ./client-runtime.gen.
            if (settings.isEmitClient()) {
                String clientFile = toKebabCase(groupName) + ".client.gen.ts";
                TypeScriptFileWriter clientWriter = new TypeScriptFileWriter();
                new ClientEmitter(model, index).emitClientFile(
                    groupName, toKebabCase(groupName), ops, errors, sharedShapeIds, sharedErrorIds,
                    clientWriter);
                clientWriter.write(context.getFileManifest(), clientFile);
                exportableFiles.add(clientFile);
                clientEmitted = true;
            }

            // Plan 13 (P3): default DB-backed CRUD factory for a @persisted resource. The
            // crud file imports from this group's ./<stem>.gen, so it rides the same stem.
            ResourceShape persisted = persistedByGroup.get(groupName);
            if (persisted != null) {
                String stem = toKebabCase(groupName);
                crudEmitter.emit(persisted, groupName, stem, sharedShapeIds, sharedErrorIds,
                        context.getFileManifest())
                    .ifPresent(exportableFiles::add);

                // Phase L1: @live resources are always @persisted (trait selector), so the
                // realtime router rides the same group stem as the crud/route files.
                if (persisted.hasTrait(com.smithyhono.traits.LiveTrait.class)) {
                    liveEmitter.emit(persisted, groupName, stem, sharedShapeIds, sharedErrorIds,
                            context.getFileManifest())
                        .ifPresent(exportableFiles::add);
                }
            }
        }

        // Single shared FetchLike for every generated client (see clientEmitted above).
        if (clientEmitted) {
            emitClientRuntimeFile(context);
            exportableFiles.add("client-runtime.gen.ts");
        }

        boolean hasPersisted = !persistedByGroup.isEmpty()
            && exportableFiles.stream().anyMatch(f -> f.endsWith(".crud.gen.ts"));
        emitPackageFiles(context, settings, exportableFiles, hasPersisted);
    }

    /** Emits client-runtime.gen.ts — the single shared {@code FetchLike} used by every client. */
    private void emitClientRuntimeFile(PluginContext context) {
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        writer.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
        writer.blank();
        writer.line("export interface FetchLike {");
        writer.line("  (input: string, init?: RequestInit): Promise<Response>");
        writer.line("}");
        writer.write(context.getFileManifest(), "client-runtime.gen.ts");
    }

    // ── npm package scaffolding ────────────────────────────────────────────────

    private static final String ERRORS_TS =
        "export interface SmithyErrorShape {\n" +
        "  readonly $statusCode: number\n" +
        "  readonly $fault: 'client' | 'server'\n" +
        "}\n" +
        "\n" +
        "// RT-08 — a global-registry brand stamped on every genuinely-modeled error.\n" +
        "// The security-core errorSanitizer reflects a modeled error's `message` to the\n" +
        "// client ONLY when this brand is present, so a library/internal error that\n" +
        "// merely happens to carry a numeric `$statusCode` cannot leak its message.\n" +
        "export const MODELED_ERROR_BRAND = Symbol.for('@smithy-hono/security-core/modeled-error')\n" +
        "\n" +
        "export class SmithyError extends Error implements SmithyErrorShape {\n" +
        "  readonly $statusCode: number\n" +
        "  readonly $fault: 'client' | 'server'\n" +
        "\n" +
        "  constructor(message: string, statusCode: number, fault: 'client' | 'server') {\n" +
        "    super(message)\n" +
        "    this.$statusCode = statusCode\n" +
        "    this.$fault = fault\n" +
        "    ;(this as Record<symbol, unknown>)[MODELED_ERROR_BRAND] = true\n" +
        "    Object.setPrototypeOf(this, new.target.prototype)\n" +
        "  }\n" +
        "}\n";

    private static final String TSCONFIG_BASE =
        "{\n" +
        "  \"compilerOptions\": {\n" +
        "    \"target\": \"ES2022\",\n" +
        "    \"lib\": [\"ES2022\", \"DOM\"],\n" +
        "    \"strict\": true,\n" +
        "    \"skipLibCheck\": true\n" +
        "  }\n" +
        "}\n";

    private static final String TSCONFIG_CJS =
        "{\n" +
        "  \"extends\": \"./tsconfig.json\",\n" +
        "  \"compilerOptions\": {\n" +
        "    \"module\": \"CommonJS\",\n" +
        "    \"moduleResolution\": \"node\",\n" +
        "    \"outDir\": \"dist-cjs\",\n" +
        "    \"rootDir\": \".\",\n" +
        "    \"declaration\": false\n" +
        "  },\n" +
        "  \"include\": [\"*.ts\"],\n" +
        "  \"exclude\": [\"*.template.ts\", \"dist-cjs\", \"dist-es\", \"dist-types\"]\n" +
        "}\n";

    private static final String TSCONFIG_ES =
        "{\n" +
        "  \"extends\": \"./tsconfig.json\",\n" +
        "  \"compilerOptions\": {\n" +
        "    \"module\": \"ESNext\",\n" +
        "    \"moduleResolution\": \"bundler\",\n" +
        "    \"outDir\": \"dist-es\",\n" +
        "    \"rootDir\": \".\",\n" +
        "    \"declaration\": false\n" +
        "  },\n" +
        "  \"include\": [\"*.ts\"],\n" +
        "  \"exclude\": [\"*.template.ts\", \"dist-cjs\", \"dist-es\", \"dist-types\"]\n" +
        "}\n";

    private static final String TSCONFIG_TYPES =
        "{\n" +
        "  \"extends\": \"./tsconfig.json\",\n" +
        "  \"compilerOptions\": {\n" +
        "    \"module\": \"ESNext\",\n" +
        "    \"moduleResolution\": \"bundler\",\n" +
        "    \"outDir\": \"dist-types\",\n" +
        "    \"rootDir\": \".\",\n" +
        "    \"declaration\": true,\n" +
        "    \"emitDeclarationOnly\": true\n" +
        "  },\n" +
        "  \"include\": [\"*.ts\"],\n" +
        "  \"exclude\": [\"*.template.ts\", \"dist-cjs\", \"dist-es\", \"dist-types\"]\n" +
        "}\n";

    private void emitPackageFiles(PluginContext context, HonoSettings settings, List<String> exportableFiles,
                                  boolean hasPersisted) {
        software.amazon.smithy.build.FileManifest manifest = context.getFileManifest();

        manifest.writeFile("errors.ts", ERRORS_TS);
        manifest.writeFile("tsconfig.json", TSCONFIG_BASE);
        manifest.writeFile("tsconfig.cjs.json", TSCONFIG_CJS);
        manifest.writeFile("tsconfig.es.json", TSCONFIG_ES);
        manifest.writeFile("tsconfig.types.json", TSCONFIG_TYPES);

        // index.ts — re-exports from every generated resource/SSE file + runtime utilities
        TypeScriptFileWriter index = new TypeScriptFileWriter();
        for (String fileName : exportableFiles) {
            String stem = fileName.replace(".ts", "");
            index.line("export * from './" + stem + "'");
        }
        index.line("export { SmithyError } from './errors'");
        index.line("export type { SmithyErrorShape } from './errors'");
        index.write(manifest, "index.ts");

        // package.json
        String packageJson =
            "{\n" +
            "  \"name\": \"" + settings.getPackageName() + "\",\n" +
            "  \"version\": \"" + settings.getPackageVersion() + "\",\n" +
            "  \"description\": \"Generated Hono routes and Zod schemas from Smithy model\",\n" +
            "  \"main\": \"./dist-cjs/index.js\",\n" +
            "  \"module\": \"./dist-es/index.js\",\n" +
            "  \"types\": \"./dist-types/index.d.ts\",\n" +
            "  \"exports\": {\n" +
            "    \".\": {\n" +
            "      \"import\": {\n" +
            "        \"types\": \"./dist-types/index.d.ts\",\n" +
            "        \"default\": \"./dist-es/index.js\"\n" +
            "      },\n" +
            "      \"require\": {\n" +
            "        \"types\": \"./dist-types/index.d.ts\",\n" +
            "        \"default\": \"./dist-cjs/index.js\"\n" +
            "      }\n" +
            "    }\n" +
            "  },\n" +
            "  \"files\": [\"dist-cjs\", \"dist-es\", \"dist-types\"],\n" +
            "  \"scripts\": {\n" +
            "    \"build\": \"concurrently 'npm:build:cjs' 'npm:build:es' 'npm:build:types'\",\n" +
            "    \"build:cjs\": \"tsc -p tsconfig.cjs.json\",\n" +
            "    \"build:es\": \"tsc -p tsconfig.es.json\",\n" +
            "    \"build:types\": \"tsc -p tsconfig.types.json\",\n" +
            "    \"clean\": \"rm -rf dist-cjs dist-es dist-types\"\n" +
            "  },\n" +
            "  \"peerDependencies\": {\n" +
            "    \"hono\": \">=4.0.0\",\n" +
            "    \"zod\": \">=3.0.0\",\n" +
            "    \"@hono/zod-validator\": \">=0.4.0\"" +
            // Plan 13 (P3): the emitted .crud.gen.ts factory imports DataStore from
            // @smithy-hono/data-core, so the consumer must provide it as a peer.
            (hasPersisted ? ",\n    \"@smithy-hono/data-core\": \">=0.1.0\"\n" : "\n") +
            "  },\n" +
            "  \"devDependencies\": {\n" +
            "    \"@hono/zod-validator\": \"^0.4.3\",\n" +
            "    \"concurrently\": \"^9.0.0\",\n" +
            "    \"hono\": \"^4.7.0\",\n" +
            "    \"typescript\": \"^5.4.0\",\n" +
            "    \"zod\": \"^3.24.0\"\n" +
            "  }\n" +
            "}\n";
        manifest.writeFile("package.json", packageJson);
    }

    // ── Shared shapes ──────────────────────────────────────────────────────────

    /**
     * Error shapes emitted by more than one resource group — these get hoisted to errors.gen.ts
     * and imported (not redeclared) by each group, so the barrel's export * has a single
     * definition. Service-level errors are bound to every op, so they always qualify.
     */
    private Set<ShapeId> findSharedErrors(Map<String, List<StructureShape>> errorsPerGroup) {
        if (errorsPerGroup.size() < 2) return new LinkedHashSet<>();

        Map<ShapeId, Integer> refCount = new LinkedHashMap<>();
        for (List<StructureShape> errs : errorsPerGroup.values()) {
            // Dedupe within a group (an error bound to several ops counts once for that group).
            Set<ShapeId> seen = new LinkedHashSet<>();
            for (StructureShape e : errs) {
                if (seen.add(e.getId())) refCount.merge(e.getId(), 1, Integer::sum);
            }
        }

        Set<ShapeId> shared = new LinkedHashSet<>();
        for (Map.Entry<ShapeId, Integer> e : refCount.entrySet()) {
            if (e.getValue() > 1) shared.add(e.getKey());
        }
        return shared;
    }

    /** Emits errors.gen.ts — error classes shared by 2+ resource groups, declared once. */
    private void emitErrorsFile(Set<ShapeId> sharedErrorIds, Model model, RouteEmitter routeEmitter,
                                PluginContext context) {
        List<StructureShape> errors = sharedErrorIds.stream()
            .map(id -> model.expectShape(id, StructureShape.class))
            .collect(Collectors.toList());
        if (errors.isEmpty()) return;

        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        writer.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
        writer.blank();
        writer.comment("---- Shared error classes ----");
        writer.blank();
        routeEmitter.emitErrorClasses(errors, writer);
        writer.write(context.getFileManifest(), "errors.gen.ts");
    }

    /** Returns the set of StructureShape IDs referenced by more than one resource group. */
    private Set<ShapeId> findSharedShapes(Map<String, Set<ShapeId>> reachablePerGroup) {
        if (reachablePerGroup.size() < 2) return Set.of();

        Map<ShapeId, Integer> refCount = new LinkedHashMap<>();
        for (Set<ShapeId> ids : reachablePerGroup.values()) {
            for (ShapeId id : ids) {
                refCount.merge(id, 1, Integer::sum);
            }
        }

        Set<ShapeId> shared = new LinkedHashSet<>();
        for (Map.Entry<ShapeId, Integer> e : refCount.entrySet()) {
            if (e.getValue() > 1) shared.add(e.getKey());
        }
        return shared;
    }

    /**
     * Emits shared.gen.ts containing schemas for structures used by multiple resource groups.
     * Imported by each resource file that references any of these shared shapes.
     */
    private void emitSharedFile(Set<ShapeId> sharedShapeIds, Model model, PluginContext context) {
        List<StructureShape> sharedStructs = sharedShapeIds.stream()
            .map(model::expectShape)
            .filter(s -> s instanceof StructureShape)
            .map(s -> (StructureShape) s)
            .filter(s -> !s.hasTrait(MixinTrait.class))
            .collect(Collectors.toList());

        if (sharedStructs.isEmpty()) return;

        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        writer.comment("DO NOT EDIT — regenerated by smithy-hono on every build");
        writer.blank();
        writer.line("import { z } from 'zod'");
        writer.blank();
        writer.comment("---- Shared Schemas ----");
        writer.blank();
        new SchemaDeclarationEmitter(model).emitDeclarations(sharedStructs, writer);
        writer.write(context.getFileManifest(), "shared.gen.ts");
    }

    /**
     * Builds an import statement for shared schemas used by the given resource group.
     * Returns null if no shared shapes are used by this group.
     */
    private String buildSharedImport(Set<ShapeId> groupReachable, Set<ShapeId> sharedShapeIds, Model model) {
        if (sharedShapeIds.isEmpty()) return null;

        List<String> importNames = new ArrayList<>();
        for (ShapeId id : sharedShapeIds) {
            if (!groupReachable.contains(id)) continue;
            Shape shape = model.expectShape(id);
            if (!(shape instanceof StructureShape)) continue;
            String safeName = ZodEmitter.safeTypeName(id.getName());
            importNames.add(ZodEmitter.schemaVarName(id.getName()));
            importNames.add("type " + safeName);
        }

        if (importNames.isEmpty()) return null;
        return "import { " + String.join(", ", importNames) + " } from './shared.gen'";
    }

    // ── Grouping / collection helpers ─────────────────────────────────────────

    private Map<String, List<OperationShape>> groupOperationsByResource(Model model, ModelIndex index) {
        Map<String, List<OperationShape>> result = new LinkedHashMap<>();
        ServiceShape service = index.getService();
        TopDownIndex topDown = TopDownIndex.of(model);

        for (ShapeId resourceId : service.getResources()) {
            ResourceShape resource = model.expectShape(resourceId, ResourceShape.class);
            String name = resource.getId().getName();
            List<OperationShape> ops = topDown.getContainedOperations(resource).stream()
                .filter(op -> op.hasTrait(HttpTrait.class))
                .sorted(Comparator.comparing(op -> op.getId().getName()))
                .collect(Collectors.toList());
            if (!ops.isEmpty()) result.put(name, ops);
        }

        List<OperationShape> serviceOps = service.getOperations().stream()
            .map(id -> model.expectShape(id, OperationShape.class))
            .filter(op -> op.hasTrait(HttpTrait.class))
            .sorted(Comparator.comparing(op -> op.getId().getName()))
            .collect(Collectors.toList());
        if (!serviceOps.isEmpty()) {
            result.put(service.getId().getName().replace("Service", ""), serviceOps);
        }

        return result;
    }

    private Set<StructureShape> collectSchemaRoots(List<OperationShape> ops, ModelIndex index) {
        Set<StructureShape> roots = new LinkedHashSet<>();
        for (OperationShape op : ops) {
            index.getInput(op).ifPresent(roots::add);
            index.getOutput(op).ifPresent(roots::add);
        }
        return roots;
    }

    private List<StructureShape> collectErrors(List<OperationShape> ops, ModelIndex index) {
        Set<ShapeId> seen = new LinkedHashSet<>();
        List<StructureShape> errors = new ArrayList<>();
        // Service-level errors always appear first
        for (StructureShape error : index.getServiceErrors()) {
            if (seen.add(error.getId())) errors.add(error);
        }
        for (OperationShape op : ops) {
            for (StructureShape error : index.getErrors(op)) {
                if (seen.add(error.getId())) errors.add(error);
            }
        }
        return errors;
    }

    private String toKebabCase(String name) {
        return name.replaceAll("([A-Z])", "-$1").toLowerCase().replaceFirst("^-", "");
    }
}
