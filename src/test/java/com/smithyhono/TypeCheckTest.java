package com.smithyhono;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Tag("slow")
class TypeCheckTest {

    @Test
    void generatedFilesTypeCheck() throws Exception {
        Path projectDir = Paths.get(".").toAbsolutePath().normalize();
        Path typeCheckDir = projectDir.resolve("typecheck");
        Path generatedDir = typeCheckDir.resolve("generated");
        Path sourceDir = projectDir.resolve(
            "build/smithyprojections/smithy-hono/source/hono-codegen");

        assertTrue(Files.exists(sourceDir),
            "Run ./gradlew smithyBuild before this test. Expected directory: " + sourceDir);

        Files.createDirectories(generatedDir);
        try (Stream<Path> files = Files.list(sourceDir)) {
            files.filter(p -> p.toString().endsWith(".ts"))
                 .forEach(src -> {
                     try {
                         Files.copy(src, generatedDir.resolve(src.getFileName()),
                             StandardCopyOption.REPLACE_EXISTING);
                     } catch (IOException e) {
                         throw new RuntimeException(e);
                     }
                 });
        }

        // Build + pack @smithy-hono/security-core FIRST, so the fixture's
        // `file:` dependency on the tarball resolves during the install below.
        // A fresh checkout (e.g. CI) has no pre-existing tarball — packing AFTER
        // the fixture install left npm unable to resolve the file: dep (ENOENT).
        // The fixture compiles security-core's built dist, whose `import('hono')`
        // then resolves from the fixture's OWN hono via the peerDependency — not a
        // source symlink dragging in the workspace-root hono.
        Path coreDir = projectDir.resolve("packages/security-core");
        // Derive the packed-tarball version from package.json (the single source of
        // truth bumped by scripts/version.mjs) instead of hardcoding it — `npm pack`
        // stamps the filename with this version, and a stale literal here broke CI on
        // the 0.1.1 -> 0.1.2 bump.
        String coreVersion = new ObjectMapper()
            .readTree(coreDir.resolve("package.json").toFile())
            .get("version").asText();
        if (!Files.exists(coreDir.resolve("node_modules"))) {
            int coreInstall = new ProcessBuilder("npm", "install", "--prefer-offline")
                .directory(coreDir.toFile())
                .inheritIO()
                .start()
                .waitFor();
            assertEquals(0, coreInstall, "npm install failed in " + coreDir);
        }
        int packCode = new ProcessBuilder("npm", "pack")
            .directory(coreDir.toFile())
            .inheritIO()
            .start()
            .waitFor();
        assertEquals(0, packCode, "npm pack failed in " + coreDir);

        if (!Files.exists(typeCheckDir.resolve("node_modules"))) {
            // --no-package-lock: resolve registry deps without writing/enforcing the
            // committed lock (whose tarball integrity changes every pack). The
            // freshly packed tarball above satisfies the file: dependency; the
            // explicit install below re-plants it as a REAL COPY.
            int installCode = new ProcessBuilder(
                    "npm", "install", "--prefer-offline", "--no-package-lock")
                .directory(typeCheckDir.toFile())
                .inheritIO()
                .start()
                .waitFor();
            assertEquals(0, installCode, "npm install failed in " + typeCheckDir);
        }

        // Install the freshly packed security-core as a REAL COPY into the
        // fixture's node_modules (dist physically copied — skew-proof).
        int tarballInstall = new ProcessBuilder(
                "npm", "install",
                "../packages/security-core/smithy-hono-security-core-" + coreVersion + ".tgz",
                "--no-save", "--no-package-lock")
            .directory(typeCheckDir.toFile())
            .inheritIO()
            .start()
            .waitFor();
        assertEquals(0, tarballInstall,
            "installing packed security-core tarball failed in " + typeCheckDir);

        ProcessBuilder pb = new ProcessBuilder("npx", "tsc", "--noEmit")
            .directory(typeCheckDir.toFile())
            .redirectErrorStream(true);

        Process proc = pb.start();
        String output = new String(proc.getInputStream().readAllBytes());
        int exitCode = proc.waitFor();

        assertEquals(0, exitCode, "TypeScript compilation failed:\n" + output);
    }
}
