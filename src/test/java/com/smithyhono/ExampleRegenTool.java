package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;

import java.io.File;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Durable regeneration tool for the committed example generated/ dirs (todo-api and,
 * Plan 13 P4, crud-api).
 *
 * Runs the real {@link HonoCodegenPlugin} over each example model and copies the
 * generated source files into examples/&lt;name&gt;/generated/. It is a NO-OP in a
 * normal test run (guarded by an Assumption) and only does work when explicitly
 * requested, mirroring SnapshotTest's UPDATE_SNAPSHOTS idiom.
 *
 * Run with:
 *   ./gradlew test --tests '*ExampleRegenTool*' -DREGEN_EXAMPLE=true
 */
class ExampleRegenTool {

    /**
     * The source files that belong in the todo-api generated/ dir. The npm-package
     * scaffolding (package.json, tsconfig*.json) is deliberately excluded — the
     * example app has its own package.json. middleware.ts is no longer emitted.
     */
    private static final List<String> TODO_FILES = List.of(
            "client-runtime.gen.ts",
            "errors.ts",
            "index.ts",
            "mcp.gen.ts",
            "permissions.gen.ts",
            "registry.gen.ts",
            "todo.client.gen.ts",
            "todo.gen.ts"
    );

    /**
     * Plan 13 (P4): the crud-api example's generated files. The Task resource is
     * {@code @persisted}, so codegen ALSO emits {@code task.crud.gen.ts} (the default
     * CRUD factory) which the zero-handler app wires to a memory store.
     */
    private static final List<String> CRUD_FILES = List.of(
            "client-runtime.gen.ts",
            "errors.ts",
            "index.ts",
            "mcp.gen.ts",
            "registry.gen.ts",
            "task.client.gen.ts",
            "task.gen.ts",
            "task.crud.gen.ts"
    );

    @Test
    void regenerateExample() throws Exception {
        assumeTrue(Boolean.getBoolean("REGEN_EXAMPLE"),
                "ExampleRegenTool is a no-op unless -DREGEN_EXAMPLE=true is set");

        regenerate("examples/todo-api", "com.example.todo#TodoService", "todo-api", TODO_FILES);
        regenerate("examples/crud-api", "com.example.crud#TaskService", "crud-api", CRUD_FILES);
    }

    /**
     * Runs codegen for one example model and copies its expected source files into
     * the example's committed generated/ dir.
     */
    private void regenerate(String exampleRelDir, String serviceId, String packageName,
                            List<String> expectedFiles) throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");

        Path projectDir = Paths.get(System.getProperty("user.dir"));
        Path modelFile = projectDir.resolve(exampleRelDir + "/model/main.smithy");
        assertTrue(Files.exists(modelFile), "example model not found: " + modelFile);
        URL modelUrl = modelFile.toUri().toURL();

        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addImport(modelUrl)
                .assemble()
                .unwrap();

        Path tempDir = Files.createTempDirectory("example-regen");
        PluginContext context = PluginContext.builder()
                .model(model)
                .fileManifest(FileManifest.create(tempDir))
                .settings(Node.objectNodeBuilder()
                        .withMember("service", serviceId)
                        .withMember("packageName", packageName)
                        .withMember("packageVersion", "0.1.0")
                        .build())
                .build();

        new HonoCodegenPlugin().execute(context);

        // Bidirectional drift guard: the set of generated-artifact files the plugin
        // ACTUALLY emitted (that belong in generated/) must equal the expected copy
        // list. This catches the case where the emitter starts producing a NEW
        // artifact (e.g. permissions.gen.ts for a future model change) that the
        // hardcoded list doesn't copy — without this, generated/ would silently drift
        // from real codegen. The example intentionally owns its own npm scaffolding
        // (package.json, tsconfig*.json, smithy-build.json) and SSE templates
        // (*.template.ts, which the dev customizes), so those are excluded — mirroring
        // what the tool copies and what the typeCheck task type-checks.
        Set<String> emittedArtifacts = generatedArtifacts(tempDir);
        Set<String> expectedSet = new TreeSet<>(expectedFiles);
        assertEquals(expectedSet, emittedArtifacts,
                "Generated-artifact drift for " + exampleRelDir + ": the files the emitter "
                        + "produces for generated/ no longer match the expected copy list. "
                        + "Update the " + packageName.toUpperCase().replace("-API", "")
                        + "_FILES list in ExampleRegenTool to match the emitter output. "
                        + "Expected " + expectedSet + " but emitter produced " + emittedArtifacts + ".");

        Path generatedDir = projectDir.resolve(exampleRelDir + "/generated");
        Files.createDirectories(generatedDir);

        for (String fileName : expectedFiles) {
            Path src = tempDir.resolve(fileName);
            if (!Files.exists(src)) {
                throw new IllegalStateException("Codegen did not emit expected file: " + fileName
                        + " for " + exampleRelDir + " (produced: " + listDir(tempDir) + ")");
            }
            Path dest = generatedDir.resolve(fileName);
            Files.copy(src, dest, StandardCopyOption.REPLACE_EXISTING);
            System.out.println("Wrote: " + dest);
        }

        // middleware.ts is no longer emitted; remove any stale copy.
        Path staleMiddleware = generatedDir.resolve("middleware.ts");
        if (Files.deleteIfExists(staleMiddleware)) {
            System.out.println("Deleted stale: " + staleMiddleware);
        }
    }

    /**
     * The files the plugin writes to its output dir that the example OWNS itself
     * (npm-package scaffolding + customizable templates), not generated artifacts.
     * These are deliberately NOT copied into generated/, so they're excluded from the
     * bidirectional drift check below.
     */
    private static boolean isExampleOwned(String fileName) {
        return fileName.equals("package.json")
                || fileName.equals("smithy-build.json")
                || fileName.startsWith("tsconfig")
                || fileName.endsWith(".template.ts");
    }

    /**
     * Enumerates the generated-artifact files the plugin emitted into {@code dir} that
     * belong in the example's generated/ dir — everything except the example-owned
     * scaffolding ({@link #isExampleOwned}). Sorted for a stable comparison/message.
     */
    private static Set<String> generatedArtifacts(Path dir) throws Exception {
        try (var stream = Files.list(dir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .filter(name -> !isExampleOwned(name))
                    .collect(Collectors.toCollection(TreeSet::new));
        }
    }

    private static String listDir(Path dir) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (var stream = Files.list(dir)) {
            stream.forEach(p -> sb.append(p.getFileName()).append(" "));
        }
        return sb.toString().trim();
    }
}
