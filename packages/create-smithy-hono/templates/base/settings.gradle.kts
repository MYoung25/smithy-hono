// The root project name determines the codegen output path
// (build/smithyprojections/<name>/source/hono-codegen); the syncGeneratedCode task
// in build.gradle.kts reads ${project.name}, so the two stay in sync automatically.
rootProject.name = "{{APP_SLUG}}"
