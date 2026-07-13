// Consumer Gradle config for the smithy-hono codegen plugin.
//
// The plugin is a Maven jar published to Maven Central as
// `com.smithy-hono:smithy-hono`. `mavenLocal()` is listed first so a locally built
// plugin (`./gradlew publishToMavenLocal` in the smithy-hono repo) is picked up
// during local development; otherwise it resolves from Maven Central.
//
// IMPORTANT:
//  1) The `java` plugin MUST be applied — the Smithy `smithy-base` plugin only
//     creates the `smithyBuild` configuration when `java` is present.
//  2) `outputDirectory` in smithy-build.json is NOT honored by the Gradle plugin;
//     generated code always lands in
//       build/smithyprojections/<root>/source/hono-codegen/
//     The `syncGeneratedCode` task below copies it into src/generated (which is
//     gitignored and regenerated), EXCLUDING *.template.ts (copy-once references).
//     The npm "codegen" script runs `./gradlew syncGeneratedCode`.

plugins {
    java
    id("software.amazon.smithy.gradle.smithy-base") version "{{SMITHY_GRADLE_VERSION}}"
}

// The codegen plugin's trait providers are compiled for Java 21 (class-file version
// 65), and the Smithy build runs in the Gradle daemon's JVM. Fail fast with a clear
// message if Gradle is launched on an older JDK — otherwise the build dies with an
// opaque `UnsupportedClassVersionError` / `InvocationTargetException`. (A `java`
// toolchain does NOT help here: it governs compile/test tasks, not the daemon JVM
// the Smithy worker uses.)
if (JavaVersion.current() < JavaVersion.VERSION_21) {
    throw GradleException(
        "smithy-hono codegen requires JDK 21+ to run Gradle (found ${JavaVersion.current()}). " +
            "Install a JDK 21 (e.g. Temurin 21) and run under it — set JAVA_HOME, or add " +
            "`org.gradle.java.home=/path/to/jdk-21` to gradle.properties.",
    )
}

repositories {
    mavenLocal()
    mavenCentral()
}

dependencies {
    // Puts the codegen plugin (+ its trait providers) on the Smithy build classpath
    // so the Smithy worker discovers HonoCodegenPlugin via ServiceLoader.
    add("smithyBuild", "com.smithy-hono:smithy-hono:{{SH_VERSION}}")
}

// Copy generated TypeScript into the server source tree (src/generated). Note (2).
tasks.register<Copy>("syncGeneratedCode") {
    dependsOn("smithyBuild")
    val gen = layout.buildDirectory.dir("smithyprojections/${project.name}/source/hono-codegen")
    from(gen) {
        include("*.ts")
        exclude("*.template.ts")
    }
    into("src/generated")
}
