import groovy.json.JsonSlurper

plugins {
    `java-library`
    `maven-publish`
    id("software.amazon.smithy.gradle.smithy-base") version "1.2.0"
    // Maven Central publishing via the Central Portal (OSSRH is sunset). vanniktech
    // adds the required -sources/-javadoc jars + POM + GPG signing that a plain
    // maven-publish publication lacks. See internal-docs/maven-central-publishing.md.
    // Pinned to 0.34.0 — the newest release compatible with this repo's Gradle 8.7
    // (0.35.0+ require Gradle 8.13+). 0.34.0 is Central-Portal-only with the no-arg
    // publishToMavenCentral() API.
    id("com.vanniktech.maven.publish") version "0.34.0"
}

// Single source of truth for the repo version. The packed-tarball paths below
// MUST match what `npm pack` emits, which is driven by each shipped package.json's
// `version` (bumped by scripts/version.mjs). Read it here so nothing drifts — the
// tarball `inputs.file(...)` checks fail when the packages are bumped but this file
// is forgotten (as in the 0.1.1 -> 0.1.2 bump), and the Maven artifact below is
// published in lockstep with the npm packages (the CI publish guard enforces that
// the tag matches every npm package, so the Maven plugin must track them too).
@Suppress("UNCHECKED_CAST")
val npmVersion = (JsonSlurper().parse(
    file("$projectDir/packages/security-core/package.json")
) as Map<String, Any>)["version"] as String

group = "com.smithy-hono"
version = npmVersion

repositories {
    mavenLocal()
    mavenCentral()
}

dependencies {
    implementation("software.amazon.smithy:smithy-model:1.61.0")
    implementation("software.amazon.smithy:smithy-build:1.61.0")
    implementation("software.amazon.smithy:smithy-codegen-core:1.61.0")
    implementation("software.amazon.smithy:smithy-validation-model:1.61.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    // Forward -DUPDATE_SNAPSHOTS=true to the test JVM for SnapshotTest
    System.getProperty("UPDATE_SNAPSHOTS")?.let { systemProperty("UPDATE_SNAPSHOTS", it) }

    // Forward -DREGEN_EXAMPLE=true to the test JVM for ExampleRegenTool
    System.getProperty("REGEN_EXAMPLE")?.let { systemProperty("REGEN_EXAMPLE", it) }

    // Forward -DREGEN_COVERAGE=true to the test JVM for CoverageRegenTool
    System.getProperty("REGEN_COVERAGE")?.let { systemProperty("REGEN_COVERAGE", it) }

    // Skip @Tag("slow") by default; run with: ./gradlew test -Dgroups=slow
    useJUnitPlatform {
        if (System.getProperty("groups") == null) {
            excludeTags("slow")
        }
    }
}

// Maven Central (Central Portal) configuration. vanniktech creates the "maven"
// publication (with -sources.jar + -javadoc.jar — Central rejects publishes without
// them; the old manual publication produced neither), builds the required POM, and
// adds the `publishToMavenCentral` / `publishAndReleaseToMavenCentral` tasks used by
// release.yml. The GitLab publish (`publishMavenPublicationToGitLabRepository`) reuses
// this same "maven" publication, so its task name is unchanged.
mavenPublishing {
    publishToMavenCentral()

    // Signing is a Central requirement, but it is applied to ALL publications — so an
    // unconditional signAllPublications() would make the GitLab CI publish (no GPG key
    // there) fail signing on a non-SNAPSHOT version. Gate it on the in-memory key: it
    // is present only on the GitHub→Central job (injected via ORG_GRADLE_PROJECT_*),
    // so GitLab CI and local `publishToMavenLocal` stay unsigned and unaffected.
    if (providers.gradleProperty("signingInMemoryKey").isPresent) {
        signAllPublications()
    }

    // groupId per Decision 0 (domain-verified com.smithy-hono); version stays derived
    // from package.json (npmVersion) so the JAR releases in lockstep with the npm packages.
    coordinates("com.smithy-hono", "smithy-hono", npmVersion)

    pom {
        name.set("smithy-hono")
        description.set("Smithy build plugin that generates Hono routes, Zod validation, typed errors, and SSE types from a Smithy model.")
        url.set("https://github.com/MYoung25/smithy-hono")
        licenses {
            license {
                name.set("The Apache License, Version 2.0")
                url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
            }
        }
        developers {
            developer {
                id.set("MYoung25")
                name.set("Michael Young")
                url.set("https://github.com/MYoung25")
            }
        }
        scm {
            url.set("https://github.com/MYoung25/smithy-hono")
            connection.set("scm:git:git://github.com/MYoung25/smithy-hono.git")
            developerConnection.set("scm:git:ssh://git@github.com/MYoung25/smithy-hono.git")
        }
    }
}

publishing {
}

tasks.register("npmBuild") {
    description = "Installs npm deps and builds CJS/ESM/types in the codegen output directory"
    group = "build"
    dependsOn("smithyBuild")

    doLast {
        val codegenDir = layout.buildDirectory
            .dir("smithyprojections/smithy-hono/source/hono-codegen")
            .get().asFile

        if (!file("${codegenDir}/node_modules").exists()) {
            exec {
                workingDir(codegenDir)
                commandLine("npm", "install", "--prefer-offline")
            }
        }

        exec {
            workingDir(codegenDir)
            commandLine("npm", "run", "build")
        }
    }
}

// Builds @smithy-hono/security-core's dist/ and produces the publish-accurate
// tarball that consumers install as a REAL COPY (not a source symlink). Installing
// the tarball physically copies dist into the consumer's node_modules, so
// security-core's `import('hono')` resolves from the CONSUMER's single hono via the
// peerDependency — permanently eliminating the two-physical-copies version-skew.
tasks.register("packSecurityCore") {
    description = "Builds + packs @smithy-hono/security-core into a consumable tarball"
    group = "build"

    val coreDir = file("$projectDir/packages/security-core")
    val tarball = file("$coreDir/smithy-hono-security-core-${npmVersion}.tgz")

    inputs.dir("$coreDir/src")
    inputs.file("$coreDir/package.json")
    inputs.file("$coreDir/tsconfig.json")
    inputs.file("$coreDir/tsconfig.build.json")
    outputs.file(tarball)

    doLast {
        if (!file("$coreDir/node_modules").exists()) {
            exec {
                workingDir(coreDir)
                commandLine("npm", "install", "--prefer-offline")
            }
        }
        // `npm pack` runs the `prepare` script (build), emitting dist/ then taring it.
        exec {
            workingDir(coreDir)
            commandLine("npm", "pack")
        }
    }
}

// Mirrors packSecurityCore for @smithy-hono/data-core (Plan 13). data-core is
// standalone (ARCH-01: web-standard only, no security-core dependency), so it packs
// independently. Generated CRUD packages + the crud-api example (P4) and adapter-node
// (P5) install this tarball as a REAL COPY, same skew-proof machinery as core.
tasks.register("packDataCore") {
    description = "Builds + packs @smithy-hono/data-core into a consumable tarball"
    group = "build"

    val coreDir = file("$projectDir/packages/data-core")
    val tarball = file("$coreDir/smithy-hono-data-core-${npmVersion}.tgz")

    inputs.dir("$coreDir/src")
    inputs.file("$coreDir/package.json")
    inputs.file("$coreDir/tsconfig.json")
    inputs.file("$coreDir/tsconfig.build.json")
    outputs.file(tarball)

    doLast {
        if (!file("$coreDir/node_modules").exists()) {
            exec {
                workingDir(coreDir)
                commandLine("npm", "install", "--prefer-offline")
            }
        }
        // `npm pack` runs the `prepare` script (build), emitting dist/ then taring it.
        exec {
            workingDir(coreDir)
            commandLine("npm", "pack")
        }
    }
}

// Mirrors packSecurityCore/packDataCore for @smithy-hono/mcp-core (Plan 14, live
// /mcp mount). mcp-core is standalone (ARCH-01: web-standard only — no security-core
// or data-core dependency; zod is a peer, zod-to-json-schema a normal dep), so it
// packs independently. The crud-api example (createCrudApp mounts /mcp) installs this
// tarball as a REAL COPY, same skew-proof machinery as the other cores.
tasks.register("packMcpCore") {
    description = "Builds + packs @smithy-hono/mcp-core into a consumable tarball"
    group = "build"

    val coreDir = file("$projectDir/packages/mcp-core")
    val tarball = file("$coreDir/smithy-hono-mcp-core-${npmVersion}.tgz")

    inputs.dir("$coreDir/src")
    inputs.file("$coreDir/package.json")
    inputs.file("$coreDir/tsconfig.json")
    inputs.file("$coreDir/tsconfig.build.json")
    outputs.file(tarball)

    doLast {
        if (!file("$coreDir/node_modules").exists()) {
            exec {
                workingDir(coreDir)
                commandLine("npm", "install", "--prefer-offline")
            }
        }
        // `npm pack` runs the `prepare` script (build), emitting dist/ then taring it.
        exec {
            workingDir(coreDir)
            commandLine("npm", "pack")
        }
    }
}

// Mirrors packSecurityCore for the Node adapter. The todo-api deployment variant
// (src/server.redis.ts, the k8s image) installs adapter-node as a REAL COPY tarball
// alongside core, so exampleIntegTest needs it packed too.
tasks.register("packAdapterNode") {
    description = "Builds + packs @smithy-hono/adapter-node into a consumable tarball"
    group = "build"

    // adapter-node's tsc build imports security-core's dist — pack core first.
    dependsOn("packSecurityCore")

    val dir = file("$projectDir/packages/adapter-node")
    val tarball = file("$dir/smithy-hono-adapter-node-${npmVersion}.tgz")

    inputs.dir("$dir/src")
    inputs.file("$dir/package.json")
    inputs.file("$dir/tsconfig.json")
    inputs.file("$dir/tsconfig.build.json")
    outputs.file(tarball)

    doLast {
        if (!file("$dir/node_modules").exists()) {
            // --ignore-scripts: do NOT run adapter-node's `prepare` (tsc build) yet —
            // it imports @smithy-hono/security-core, which a standalone install hasn't
            // provided (it's a peerDependency + workspace sibling, not on the registry).
            // The build runs in `npm pack` below, after the core tarball is planted.
            exec {
                workingDir(dir)
                commandLine("npm", "install", "--prefer-offline", "--ignore-scripts")
            }
        }
        // Plant the freshly packed security-core as a REAL COPY so adapter-node's tsc
        // build resolves `@smithy-hono/security-core` (+ its /storage subpath export).
        // CI has no root workspace node_modules to resolve the sibling through.
        exec {
            workingDir(dir)
            commandLine(
                "npm", "install",
                "../security-core/smithy-hono-security-core-${npmVersion}.tgz",
                "--no-save", "--no-package-lock", "--ignore-scripts",
            )
        }
        exec {
            workingDir(dir)
            commandLine("npm", "pack")
        }
    }
}

// Mirrors packAdapterNode for @smithy-hono/test-kit (the consumer testing toolkit).
// test-kit's tsc build imports @smithy-hono/security-core's dist, so pack core first
// and plant it as a real copy before packing (same skew-proof machinery as the
// adapter). hono is a registry devDep, resolved by the standalone install.
tasks.register("packTestKit") {
    description = "Builds + packs @smithy-hono/test-kit into a consumable tarball"
    group = "build"

    dependsOn("packSecurityCore")

    val dir = file("$projectDir/packages/test-kit")
    val tarball = file("$dir/smithy-hono-test-kit-${npmVersion}.tgz")

    inputs.dir("$dir/src")
    inputs.file("$dir/package.json")
    inputs.file("$dir/tsconfig.json")
    inputs.file("$dir/tsconfig.build.json")
    outputs.file(tarball)

    doLast {
        if (!file("$dir/node_modules").exists()) {
            // --ignore-scripts: defer the `prepare` (tsc) build until security-core is planted.
            exec {
                workingDir(dir)
                commandLine("npm", "install", "--prefer-offline", "--ignore-scripts")
            }
        }
        // Plant the freshly packed security-core as a real copy so test-kit's tsc build
        // resolves '@smithy-hono/security-core' (CI has no root workspace node_modules).
        exec {
            workingDir(dir)
            commandLine(
                "npm", "install",
                "../security-core/smithy-hono-security-core-${npmVersion}.tgz",
                "--no-save", "--no-package-lock", "--ignore-scripts",
            )
        }
        exec {
            workingDir(dir)
            commandLine("npm", "pack")
        }
    }
}

tasks.build {
    dependsOn("npmBuild", "test", "exampleIntegTest")
}

tasks.named("test") {
    mustRunAfter("npmBuild")
}

tasks.register("exampleIntegTest") {
    description = "Runs vitest behavior/integration tests for the todo-api example"
    mustRunAfter("test")
    group = "verification"
    // Must compile/test against the freshly built security-core + adapter-node dist
    // (the Redis deployment variant imports adapter-node). packAdapterNode pulls in
    // packSecurityCore transitively. Plan 13 (P5): adapter-node now peer-depends on
    // @smithy-hono/data-core, so the example must plant that tarball too — otherwise
    // npm tries to resolve the peer from the registry and 404s. packDataCore provides it.
    dependsOn("packAdapterNode")
    dependsOn("packDataCore")
    // Plan 14 §11: the new MCP auth e2e (test/mcp-auth-e2e.test.ts) imports
    // @smithy-hono/mcp-core (todo-api now serves its ops as a protected MCP server).
    // Pack + plant it as a real copy alongside the others (verifier is injected, so
    // mcp-core stays standalone — no security-core dep, mirroring crudExampleIntegTest).
    dependsOn("packMcpCore")
    // The example's tests now use @smithy-hono/test-kit (the consumer testing toolkit).
    dependsOn("packTestKit")

    inputs.dir("$projectDir/examples/todo-api/src")
    inputs.dir("$projectDir/examples/todo-api/generated")
    inputs.dir("$projectDir/examples/todo-api/test")
    inputs.file("$projectDir/examples/todo-api/package.json")
    inputs.file("$projectDir/packages/security-core/smithy-hono-security-core-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/adapter-node/smithy-hono-adapter-node-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/data-core/smithy-hono-data-core-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/mcp-core/smithy-hono-mcp-core-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/test-kit/smithy-hono-test-kit-${npmVersion}.tgz")
    outputs.file("$projectDir/examples/todo-api/.vitest-passed")

    doLast {
        val exampleDir = file("$projectDir/examples/todo-api")

        if (!file("$exampleDir/node_modules").exists()) {
            // --no-package-lock: the committed lockfile deliberately omits the
            // volatile @smithy-hono/security-core tarball entry (its integrity
            // changes every pack). Resolving without writing/enforcing the lock
            // installs the registry deps deterministically and avoids any stale
            // tarball-integrity mismatch on a clean checkout. The explicit refresh
            // step below then plants the freshly packed tarball as a real copy.
            exec {
                workingDir(exampleDir)
                commandLine("npm", "install", "--prefer-offline", "--no-package-lock")
            }
        }

        // Install the freshly packed security-core + adapter-node as REAL COPIES (dist
        // physically copied into the consumer's node_modules). --no-save/--no-package-lock
        // keeps package.json + lock stable while refreshing the installed files, so the
        // peer-resolved hono comes from the example's own copy (skew-proof).
        exec {
            workingDir(exampleDir)
            commandLine(
                "npm", "install",
                "../../packages/security-core/smithy-hono-security-core-${npmVersion}.tgz",
                "../../packages/data-core/smithy-hono-data-core-${npmVersion}.tgz",
                "../../packages/adapter-node/smithy-hono-adapter-node-${npmVersion}.tgz",
                "../../packages/mcp-core/smithy-hono-mcp-core-${npmVersion}.tgz",
                "../../packages/test-kit/smithy-hono-test-kit-${npmVersion}.tgz",
                "--no-save", "--no-package-lock",
            )
        }

        exec {
            workingDir(exampleDir)
            commandLine("npm", "test")
        }

        file("$exampleDir/.vitest-passed").writeText("ok")
    }
}

// Plan 13 (P4): the zero-handler CRUD example. Mirrors exampleIntegTest's
// pack-tarballs + repack-safe-install + vitest steps but for examples/crud-api,
// which has NO implementation.ts — the generated task.crud.gen.ts factory is the
// whole impl, backed by the in-memory DataStore from @smithy-hono/data-core.
//
// Deps: packDataCore (the crud factory imports DataStore + createMemoryDataStore),
// packSecurityCore (the generated route + crud files import SecurityEnv / authorize
// from security-core), and packMcpCore (createCrudApp now mounts /mcp via the
// @smithy-hono/mcp-core bridge — Plan 14 live mount). adapter-node is NOT needed —
// memory store only.
tasks.register("crudExampleIntegTest") {
    description = "Runs vitest e2e for the zero-handler crud-api example (memory store)"
    mustRunAfter("test")
    group = "verification"
    dependsOn("packDataCore")
    dependsOn("packSecurityCore")
    dependsOn("packMcpCore")

    inputs.dir("$projectDir/examples/crud-api/src")
    inputs.dir("$projectDir/examples/crud-api/generated")
    inputs.dir("$projectDir/examples/crud-api/test")
    inputs.file("$projectDir/examples/crud-api/package.json")
    inputs.file("$projectDir/packages/data-core/smithy-hono-data-core-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/security-core/smithy-hono-security-core-${npmVersion}.tgz")
    inputs.file("$projectDir/packages/mcp-core/smithy-hono-mcp-core-${npmVersion}.tgz")
    outputs.file("$projectDir/examples/crud-api/.vitest-passed")

    doLast {
        val exampleDir = file("$projectDir/examples/crud-api")

        if (!file("$exampleDir/node_modules").exists()) {
            // --no-package-lock: the committed lockfile deliberately omits the
            // volatile @smithy-hono/* tarball entries (their integrity changes on
            // every pack). Resolving without writing/enforcing the lock installs the
            // registry deps deterministically; the explicit refresh below then plants
            // the freshly packed tarballs as real copies (skew-proof, no symlinks).
            exec {
                workingDir(exampleDir)
                commandLine("npm", "install", "--prefer-offline", "--no-package-lock")
            }
        }

        // Install the freshly packed data-core + security-core + mcp-core as REAL
        // COPIES (dist physically copied into node_modules). --no-save/--no-package-lock
        // keeps package.json + lock stable while refreshing the installed files.
        exec {
            workingDir(exampleDir)
            commandLine(
                "npm", "install",
                "../../packages/data-core/smithy-hono-data-core-${npmVersion}.tgz",
                "../../packages/security-core/smithy-hono-security-core-${npmVersion}.tgz",
                "../../packages/mcp-core/smithy-hono-mcp-core-${npmVersion}.tgz",
                "--no-save", "--no-package-lock",
            )
        }

        // Type-check the generated CRUD factory before driving it with vitest. vitest
        // (esbuild) strips types, so a type error or drift between task.crud.gen.ts and
        // the TaskOperations interface in task.gen.ts would NOT fail `npm test` — tsc
        // --noEmit is what proves the generated factory actually compiles against the
        // regenerated generated/ dir. (todo-api's exampleIntegTest has no generated
        // impl surface, so it skips this; the CRUD factory is the new surface.)
        exec {
            workingDir(exampleDir)
            commandLine("npm", "run", "typecheck")
        }

        exec {
            workingDir(exampleDir)
            commandLine("npm", "test")
        }

        file("$exampleDir/.vitest-passed").writeText("ok")
    }
}

tasks.named("check") {
    dependsOn("exampleIntegTest")
    dependsOn("crudExampleIntegTest")
    dependsOn("typeCheck")
    dependsOn("runtimeTest")
}

// CG-11 — regenerate the behavioral coverage fixture (runtime-tests/generated/)
// from runtime-tests/model/coverage.smithy by running CoverageRegenTool with the
// regen flag. Run as a dedicated Test task (not the main `test`) so it always
// regenerates fresh, catching emitter regressions behaviorally on every CI run.
tasks.register<Test>("regenCoverageFixture") {
    description = "Regenerates runtime-tests/generated/ from the coverage model"
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    systemProperty("REGEN_COVERAGE", "true")
    useJUnitPlatform()
    filter { includeTestsMatching("com.smithyhono.CoverageRegenTool") }
    // Always rerun: its job is to refresh the (gitignored) generated fixture.
    outputs.upToDateWhen { false }
}

// CG-11 — drive real requests through the freshly generated zValidators with vitest.
// Snapshot tests assert emitted TEXT and typeCheck asserts it COMPILES; this asserts
// the generated validators BEHAVE (accept/reject the right payloads).
tasks.register("runtimeTest") {
    description = "Runs the behavioral validator harness (vitest) against generated routers"
    group = "verification"
    dependsOn("regenCoverageFixture")

    doLast {
        val runtimeDir = file("$projectDir/runtime-tests")

        if (!file("$runtimeDir/node_modules").exists()) {
            exec {
                workingDir(runtimeDir)
                commandLine("npm", "install", "--prefer-offline", "--no-package-lock")
            }
        }

        // Type-check the freshly generated output (incl. union TS types, CG-03) before
        // driving it — esbuild/vitest strips types, so tsc is what proves it compiles.
        exec {
            workingDir(runtimeDir)
            commandLine("npx", "tsc", "--noEmit")
        }

        exec {
            workingDir(runtimeDir)
            commandLine("npx", "vitest", "run")
        }
    }
}

tasks.register("typeCheck") {
    description = "Type-checks generated TypeScript files with tsc --noEmit"
    group = "verification"
    dependsOn("smithyBuild")
    // Generated code imports @smithy-hono/security-core — compile against its
    // freshly built dist (real copy), not the source symlink.
    dependsOn("packSecurityCore")

    doLast {
        val genSource = layout.buildDirectory
            .dir("smithyprojections/smithy-hono/source/hono-codegen")
            .get().asFile
        val genTarget = file("$projectDir/typecheck/generated")
        genTarget.mkdirs()

        copy {
            from(genSource) { include("*.ts"); exclude("*.template.ts") }
            into(genTarget)
        }

        val typeCheckDir = file("$projectDir/typecheck")

        if (!file("$typeCheckDir/node_modules").exists()) {
            // --no-package-lock: the committed lockfile deliberately omits the
            // volatile @smithy-hono/security-core tarball entry (its integrity
            // changes every pack). Resolving without writing/enforcing the lock
            // installs the registry deps deterministically and avoids any stale
            // tarball-integrity mismatch on a clean checkout. The explicit refresh
            // step below then plants the freshly packed tarball as a real copy.
            exec {
                workingDir(typeCheckDir)
                commandLine("npm", "install", "--prefer-offline", "--no-package-lock")
            }
        }

        // Refresh the real-copy security-core dist in the fixture's node_modules.
        exec {
            workingDir(typeCheckDir)
            commandLine(
                "npm", "install",
                "../packages/security-core/smithy-hono-security-core-${npmVersion}.tgz",
                "--no-save", "--no-package-lock",
            )
        }

        exec {
            workingDir(typeCheckDir)
            commandLine("npx", "tsc", "--noEmit")
        }
    }
}

// smithyBuild needs the compiled plugin classes (compileJava) and service
// registration files (processResources) to be discoverable via ServiceLoader.
// smithy-base doesn't add jar staging (unlike smithy-jar), so there's no
// circular dependency here.
tasks.named("smithyBuild") {
    dependsOn("compileJava", "processResources")
}

// The smithy-base plugin uses cliClasspath + smithyBuild configuration as the
// worker classloader for running the Smithy CLI. Adding the project's compiled
// output to the smithyBuild configuration makes HonoCodegenPlugin discoverable
// via ServiceLoader inside the Smithy CLI worker.
afterEvaluate {
    dependencies {
        add("smithyBuild", files(sourceSets["main"].output.classesDirs))
        add("smithyBuild", files(sourceSets["main"].output.resourcesDir))
    }
}
