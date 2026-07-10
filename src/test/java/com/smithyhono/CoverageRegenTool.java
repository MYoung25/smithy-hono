package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Durable regeneration tool for the runtime/behavioral test harness (CG-11).
 *
 * Runs the real {@link HonoCodegenPlugin} over runtime-tests/model/coverage.smithy
 * and copies the generated source into runtime-tests/generated/, where a vitest
 * suite drives real requests through the generated zValidators. It is a NO-OP in a
 * normal test run (guarded by an Assumption) and only does work when explicitly
 * requested, mirroring ExampleRegenTool / SnapshotTest's UPDATE_SNAPSHOTS idiom.
 *
 * Run with:
 *   ./gradlew test --tests '*CoverageRegenTool*' -DREGEN_COVERAGE=true
 */
class CoverageRegenTool {

    @Test
    void regenerateCoverage() throws Exception {
        assumeTrue(Boolean.getBoolean("REGEN_COVERAGE"),
                "CoverageRegenTool is a no-op unless -DREGEN_COVERAGE=true is set");

        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");

        Path projectDir = Paths.get(System.getProperty("user.dir"));
        Path modelFile = projectDir.resolve("runtime-tests/model/coverage.smithy");
        URL modelUrl = modelFile.toUri().toURL();

        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addImport(modelUrl)
                .assemble()
                .unwrap();

        Path tempDir = Files.createTempDirectory("coverage-regen");
        PluginContext context = PluginContext.builder()
                .model(model)
                .fileManifest(FileManifest.create(tempDir))
                .settings(Node.objectNodeBuilder()
                        .withMember("service", "com.coverage#CoverageService")
                        .withMember("packageName", "coverage")
                        .withMember("packageVersion", "0.1.0")
                        .build())
                .build();

        new HonoCodegenPlugin().execute(context);

        Path generatedDir = projectDir.resolve("runtime-tests/generated");
        Files.createDirectories(generatedDir);

        // Copy every emitted .ts file (route file, registry, errors, index, …),
        // excluding npm scaffolding (package.json/tsconfig*) — the harness has its
        // own. Templates are skipped: they are scaffolds, not type-checkable output.
        try (Stream<Path> files = Files.list(tempDir)) {
            files.filter(p -> p.toString().endsWith(".ts"))
                 .filter(p -> !p.toString().endsWith(".template.ts"))
                 .forEach(src -> {
                     try {
                         Path dest = generatedDir.resolve(src.getFileName());
                         Files.copy(src, dest, StandardCopyOption.REPLACE_EXISTING);
                         System.out.println("Wrote: " + dest);
                     } catch (Exception e) {
                         throw new RuntimeException(e);
                     }
                 });
        }
    }
}
