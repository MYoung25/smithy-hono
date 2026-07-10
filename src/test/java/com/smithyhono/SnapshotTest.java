package com.smithyhono;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Snapshot tests: run the full HonoCodegenPlugin on each fixture model and
 * compare the generated output against committed expected files.
 *
 * To update all snapshots after intentional changes:
 *   ./gradlew test -DUPDATE_SNAPSHOTS=true
 *
 * Snapshots live at:
 *   src/test/resources/snapshots/<model-name>/<generated-file>
 */
class SnapshotTest {

    @ParameterizedTest(name = "{0} -> {2}")
    @MethodSource("snapshotCases")
    void matchesSnapshot(String modelFile, String serviceId, String expectedFile) throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        URL modelUrl = getClass().getResource("/models/" + modelFile);
        assertNotNull(modelUrl, "Fixture model not found: " + modelFile);

        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addImport(modelUrl)
                .assemble()
                .unwrap();

        Path outputDir = Files.createTempDirectory("snapshot-test");
        PluginContext context = PluginContext.builder()
                .model(model)
                .fileManifest(FileManifest.create(outputDir))
                .settings(Node.objectNodeBuilder()
                        .withMember("service", serviceId)
                        .build())
                .build();

        new HonoCodegenPlugin().execute(context);

        Path actualFile = outputDir.resolve(expectedFile);
        assertTrue(Files.exists(actualFile),
                "Plugin did not produce expected file: " + expectedFile +
                "\nFiles in output: " + listDir(outputDir));
        String actual = Files.readString(actualFile);

        String modelName = modelFile.replace(".smithy", "");
        boolean update = Boolean.getBoolean("UPDATE_SNAPSHOTS");

        Path snapshotPath = snapshotDir().resolve(modelName).resolve(expectedFile);

        if (update) {
            Files.createDirectories(snapshotPath.getParent());
            Files.writeString(snapshotPath, actual);
            System.out.println("Updated snapshot: " + snapshotPath);
        } else {
            assertTrue(Files.exists(snapshotPath),
                    "Snapshot missing — run with -DUPDATE_SNAPSHOTS=true to create it:\n  " + snapshotPath);
            String expected = Files.readString(snapshotPath);
            assertEquals(expected, actual,
                    "Snapshot mismatch for " + modelName + "/" + expectedFile +
                    "\nRun ./gradlew test -DUPDATE_SNAPSHOTS=true to update.");
        }
    }

    static Stream<Arguments> snapshotCases() {
        return Stream.of(
                Arguments.of("basic-crud.smithy",      "com.test#PlaythroughService",   "playthrough.gen.ts"),
                Arguments.of("basic-crud.smithy",      "com.test#PlaythroughService",   "permissions.gen.ts"),
                Arguments.of("basic-crud.smithy",      "com.test#PlaythroughService",   "registry.gen.ts"),
                Arguments.of("basic-crud.smithy",      "com.test#PlaythroughService",   "mcp.gen.ts"),
                Arguments.of("mixed-bindings.smithy",  "com.test#MixedBindingsService", "mixed-bindings.gen.ts"),
                Arguments.of("mixed-bindings.smithy",  "com.test#MixedBindingsService", "registry.gen.ts"),
                Arguments.of("mixed-bindings.smithy",  "com.test#MixedBindingsService", "mcp.gen.ts"),
                Arguments.of("error-shapes.smithy",    "com.test#ErrorShapeService",    "error-shape.gen.ts"),
                Arguments.of("error-shapes.smithy",    "com.test#ErrorShapeService",    "registry.gen.ts"),
                Arguments.of("error-shapes.smithy",    "com.test#ErrorShapeService",    "mcp.gen.ts"),
                Arguments.of("recursive-types.smithy", "com.test#TreeService",          "tree.gen.ts"),
                Arguments.of("recursive-types.smithy", "com.test#TreeService",          "registry.gen.ts"),
                Arguments.of("recursive-types.smithy", "com.test#TreeService",          "mcp.gen.ts"),
                Arguments.of("sse-events.smithy",      "com.test#GameService",          "events.gen.ts"),
                Arguments.of("sse-events.smithy",      "com.test#GameService",          "registry.gen.ts"),
                Arguments.of("sse-events.smithy",      "com.test#GameService",          "mcp.gen.ts"),
                Arguments.of("union-shapes.smithy",    "com.test#UnionService",         "union.gen.ts"),
                Arguments.of("union-shapes.smithy",    "com.test#UnionService",         "registry.gen.ts"),
                Arguments.of("union-shapes.smithy",    "com.test#UnionService",         "mcp.gen.ts"),
                Arguments.of("reserved-names.smithy",  "com.test#ReservedService",      "reserved.gen.ts"),
                Arguments.of("reserved-names.smithy",  "com.test#ReservedService",      "registry.gen.ts"),
                Arguments.of("reserved-names.smithy",  "com.test#ReservedService",      "mcp.gen.ts"),
                Arguments.of("output-bindings.smithy", "com.test#OutputBindingService", "output-binding.gen.ts"),
                Arguments.of("output-bindings.smithy", "com.test#OutputBindingService", "registry.gen.ts"),
                Arguments.of("output-bindings.smithy", "com.test#OutputBindingService", "mcp.gen.ts"),
                Arguments.of("shape-coverage.smithy",  "com.test#ShapeCoverageService", "shape-coverage.gen.ts"),
                Arguments.of("shape-coverage.smithy",  "com.test#ShapeCoverageService", "registry.gen.ts"),
                Arguments.of("shape-coverage.smithy",  "com.test#ShapeCoverageService", "mcp.gen.ts"),
                Arguments.of("mcp-prompts.smithy",     "com.test#NoteService",          "mcp.gen.ts"),

                // Generated typed fetch clients (one per router file above).
                Arguments.of("basic-crud.smithy",      "com.test#PlaythroughService",   "playthrough.client.gen.ts"),
                Arguments.of("mixed-bindings.smithy",  "com.test#MixedBindingsService", "mixed-bindings.client.gen.ts"),
                Arguments.of("error-shapes.smithy",    "com.test#ErrorShapeService",    "error-shape.client.gen.ts"),
                Arguments.of("recursive-types.smithy", "com.test#TreeService",          "tree.client.gen.ts"),
                Arguments.of("union-shapes.smithy",    "com.test#UnionService",         "union.client.gen.ts"),
                Arguments.of("reserved-names.smithy",  "com.test#ReservedService",      "reserved.client.gen.ts"),
                Arguments.of("output-bindings.smithy", "com.test#OutputBindingService", "output-binding.client.gen.ts"),
                Arguments.of("shape-coverage.smithy",  "com.test#ShapeCoverageService", "shape-coverage.client.gen.ts")
        );
    }

    private Path snapshotDir() throws Exception {
        // Compute the path to src/test/resources from the project working directory.
        // Gradle sets user.dir to the project root during test execution.
        return Paths.get(System.getProperty("user.dir"))
                .resolve("src/test/resources/snapshots");
    }

    private String listDir(Path dir) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (var stream = Files.list(dir)) {
            stream.forEach(p -> sb.append("\n  ").append(p.getFileName()));
        }
        return sb.toString();
    }
}
