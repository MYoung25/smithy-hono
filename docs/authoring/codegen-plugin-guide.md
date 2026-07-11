---
id: codegen-plugin-guide
title: Codegen plugin guide
sidebar_label: Codegen plugin guide
sidebar_position: 1
---

# Smithy Codegen Plugin — Complete Guide for AI Agents

> **Audience:** AI agents tasked with implementing a Smithy build plugin that generates code
> in any target language. TypeScript/Hono/Zod is used throughout as a concrete example target,
> but every pattern here applies equally to Rust, Python, Go, or any other language.
>
> **What this guide covers:**
> 1. How Smithy's plugin system works
> 2. Project skeleton (Gradle, directory layout, ServiceLoader wiring)
> 3. Reading and navigating the Smithy model AST
> 4. Writing a code generator (emitter pattern, file writing)
> 5. Custom traits
> 6. Settings / configuration
> 7. Testing at every layer (unit → snapshot → type-check → behavioral)
> 8. Publishing
> 9. CI
> 10. Language-agnostic generalisation notes

---

## 1. How Smithy's Plugin System Works

Smithy's build pipeline is declared in `smithy-build.json`. The `plugins` block maps plugin names
to config objects. Smithy discovers plugins at runtime via Java's **ServiceLoader** mechanism:

```
smithy-build.json:
  "plugins": { "my-codegen": { "service": "com.example#MyService" } }
                      │
                      └─► ServiceLoader looks for META-INF/services/
                            software.amazon.smithy.build.SmithyBuildPlugin
                          which contains the FQCN of your plugin class
```

Your plugin class implements `SmithyBuildPlugin`, which has two methods:

```java
public interface SmithyBuildPlugin {
    String getName();             // must match the key in smithy-build.json
    void execute(PluginContext);  // called once per smithy-build run
}
```

`PluginContext` gives you:
- `context.getModel()` — the fully-assembled, validated `Model`
- `context.getSettings()` — the plugin's config `ObjectNode` from smithy-build.json
- `context.getFileManifest()` — write generated files via `manifest.writeFile(path, content)`

---

## 2. Project Skeleton

### 2.1 Directory Layout

```
my-plugin/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── smithy-build.json                     # optional: generate from your own plugin's model
├── model/                                # optional: Smithy traits you define
│   └── traits.smithy
├── src/
│   ├── main/
│   │   ├── java/com/myplugin/
│   │   │   ├── MyPlugin.java             # SmithyBuildPlugin implementation
│   │   │   ├── MySettings.java           # config parsing
│   │   │   ├── ModelIndex.java           # model navigation utilities
│   │   │   ├── traits/
│   │   │   │   └── MyCustomTrait.java
│   │   │   └── writers/
│   │   │       ├── FileWriter.java       # buffered file accumulator
│   │   │       ├── SchemaEmitter.java    # emits type/schema declarations
│   │   │       └── RouteEmitter.java     # emits route/handler code
│   │   └── resources/META-INF/services/
│   │       ├── software.amazon.smithy.build.SmithyBuildPlugin
│   │       └── software.amazon.smithy.model.traits.TraitService  # if you have custom traits
│   └── test/
│       ├── java/com/myplugin/
│       │   ├── SnapshotTest.java
│       │   ├── SchemaEmitterTest.java
│       │   ├── RouteEmitterTest.java
│       │   └── EdgeCasesTest.java
│       └── resources/
│           ├── traits.smithy             # copy of your trait definitions for tests
│           ├── models/
│           │   ├── basic-crud.smithy
│           │   ├── edge-cases.smithy
│           │   └── ...
│           └── snapshots/
│               ├── basic-crud/
│               │   └── output.gen.ext
│               └── ...
└── examples/
    └── my-example/
        ├── model/main.smithy
        ├── smithy-build.json
        └── test/behavior.test.ts         # or equivalent for your target language
```

### 2.2 build.gradle.kts

```kotlin
plugins {
    `java-library`
    `maven-publish`
    id("software.amazon.smithy.gradle.smithy-base") version "1.2.0"
}

group = "com.myplugin"
version = "0.1.0"

repositories {
    mavenLocal()
    mavenCentral()
}

dependencies {
    implementation("software.amazon.smithy:smithy-model:1.61.0")
    implementation("software.amazon.smithy:smithy-build:1.61.0")
    implementation("software.amazon.smithy:smithy-codegen-core:1.61.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    // Allow snapshot update flag to be passed through
    System.getProperty("UPDATE_SNAPSHOTS")?.let { systemProperty("UPDATE_SNAPSHOTS", it) }
    useJUnitPlatform {
        // Exclude slow tests (e.g. TypeScript type-check) unless explicitly requested
        if (System.getProperty("groups") == null) {
            excludeTags("slow")
        }
    }
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
        }
    }
}

// CRITICAL: make the plugin's own classes available to smithyBuild's classloader
afterEvaluate {
    dependencies {
        add("smithyBuild", files(sourceSets["main"].output.classesDirs))
        add("smithyBuild", files(sourceSets["main"].output.resourcesDir))
    }
}

tasks.named("smithyBuild") {
    dependsOn("compileJava", "processResources")
}
```

Key insight: `smithyBuild` runs in the same JVM as Gradle, but the plugin is discovered via
ServiceLoader. Without the `afterEvaluate` block adding your compiled classes to the
`smithyBuild` configuration, the ServiceLoader won't find your plugin.

### 2.3 settings.gradle.kts

```kotlin
rootProject.name = "my-plugin"
```

### 2.4 gradle.properties

```properties
org.gradle.jvmargs=-Xmx2g
```

### 2.5 ServiceLoader Registration Files

**`src/main/resources/META-INF/services/software.amazon.smithy.build.SmithyBuildPlugin`**
```
com.myplugin.MyPlugin
```

**`src/main/resources/META-INF/services/software.amazon.smithy.model.traits.TraitService`**
```
com.myplugin.traits.MyCustomTrait$Provider
```
(Only needed if you define custom traits.)

---

## 3. Reading the Smithy Model AST

### 3.1 Core Types

| Smithy concept | Java type |
|---|---|
| The entire model | `software.amazon.smithy.model.Model` |
| A service | `ServiceShape` |
| An operation | `OperationShape` |
| A structure | `StructureShape` |
| A member of a structure | `MemberShape` |
| Any shape ID | `ShapeId` (e.g. `ShapeId.from("com.example#MyShape")`) |

### 3.2 Assembling a Model (for tests)

```java
Model model = Model.assembler()
    .addUnparsedModel("test.smithy",
        "$version: \"2.0\"\nnamespace test\n" + smithyDefinition)
    .assemble()
    .unwrap();  // throws if model has validation errors
```

To load from files (for tests with multiple smithy files):
```java
Model model = Model.assembler()
    .addImport(getClass().getResource("/traits.smithy"))
    .addImport(getClass().getResource("/models/basic-crud.smithy"))
    .assemble()
    .unwrap();
```

### 3.3 Key Model Navigation APIs

```java
// Get a specific shape
ServiceShape svc = model.expectShape(ShapeId.from("com.example#MyService"), ServiceShape.class);

// All operations reachable from a service (including those on child resources)
TopDownIndex topDown = TopDownIndex.of(model);
Set<OperationShape> allOps = topDown.getContainedOperations(svc);

// Operations directly on a service
Set<ShapeId> directOpIds = svc.getOperations();

// Resources
Set<ShapeId> resourceIds = svc.getResources();

// Operation input/output
Optional<ShapeId> inputId = op.getInput();
Optional<ShapeId> outputId = op.getOutput();
StructureShape input = model.expectShape(inputId.get(), StructureShape.class);

// Members of a structure
Map<String, MemberShape> members = struct.getAllMembers();

// The concrete type a member points to
Shape targetShape = model.expectShape(member.getTarget());

// Errors on an operation
List<ShapeId> errorIds = op.getErrors();

// Errors on a service (service-level = attached to all operations)
List<ShapeId> serviceErrorIds = svc.getErrors();
```

### 3.4 Reading Traits

```java
// Check if a shape has a trait
if (op.hasTrait(HttpTrait.class)) {
    HttpTrait http = op.expectTrait(HttpTrait.class);
    String method = http.getMethod();         // "GET", "POST", etc.
    String uri = http.getUri().toString();    // "/todos/{id}"
    int code = http.getCode();               // 200, 201, 204, etc.
}

// HTTP binding traits on members
if (member.hasTrait(HttpLabelTrait.class))   { /* path parameter */ }
if (member.hasTrait(HttpQueryTrait.class))   { /* query parameter */ }
if (member.hasTrait(HttpHeaderTrait.class))  { /* header */ }
if (member.hasTrait(HttpPayloadTrait.class)) { /* explicit body payload */ }

// Error traits
if (shape.hasTrait(ErrorTrait.class)) {
    String fault = shape.expectTrait(ErrorTrait.class).getValue(); // "client" or "server"
}
if (shape.hasTrait(HttpErrorTrait.class)) {
    int statusCode = shape.expectTrait(HttpErrorTrait.class).getCode(); // e.g. 404
}

// Required/optional
boolean required = member.hasTrait(RequiredTrait.class);

// Constraint traits
if (shape.hasTrait(LengthTrait.class)) {
    LengthTrait len = shape.expectTrait(LengthTrait.class);
    len.getMin(); // Optional<Long>
    len.getMax(); // Optional<Long>
}
if (shape.hasTrait(PatternTrait.class)) {
    String regex = shape.expectTrait(PatternTrait.class).getValue();
}
if (member.hasTrait(RangeTrait.class)) {
    RangeTrait range = member.expectTrait(RangeTrait.class);
    range.getMin(); // Optional<BigDecimal>
    range.getMax(); // Optional<BigDecimal>
}

// Sparse collections (members can be null)
boolean sparse = shape.hasTrait(SparseTrait.class);

// Mixins (inlined at compile time — skip as standalone emitted shapes)
boolean isMixin = shape.hasTrait(MixinTrait.class);
```

### 3.5 Shape Type Dispatch

Use `instanceof` checks or `shape.getType()`:

```java
Shape shape = model.expectShape(id);
if (shape instanceof StringShape)    { /* string */ }
if (shape instanceof IntegerShape)   { /* integer */ }
if (shape instanceof LongShape)      { /* long */ }
if (shape instanceof FloatShape)     { /* float */ }
if (shape instanceof DoubleShape)    { /* double */ }
if (shape instanceof BooleanShape)   { /* boolean */ }
if (shape instanceof TimestampShape) { /* timestamp */ }
if (shape instanceof BlobShape)      { /* binary */ }
if (shape instanceof BigDecimalShape){ /* decimal */ }
if (shape instanceof BigIntegerShape){ /* big integer */ }
if (shape instanceof StructureShape) { /* object */ }
if (shape instanceof ListShape)      { /* array */
    ListShape list = (ListShape) shape;
    Shape memberTarget = model.expectShape(list.getMember().getTarget());
}
if (shape instanceof MapShape)       { /* record/map */
    MapShape map = (MapShape) shape;
    Shape valueTarget = model.expectShape(map.getValue().getTarget());
}
if (shape instanceof EnumShape)      { /* string enum */
    EnumShape e = (EnumShape) shape;
    List<String> values = e.getEnumValues().values().stream().toList();
}
if (shape instanceof IntEnumShape)   { /* integer enum */
    IntEnumShape e = (IntEnumShape) shape;
    Map<String, Integer> values = e.getEnumValues();
}
if (shape instanceof UnionShape)     { /* discriminated union */
    UnionShape u = (UnionShape) shape;
    Map<String, MemberShape> variants = u.getAllMembers();
}
```

---

## 4. Writing a Code Generator

### 4.1 The FileWriter Pattern

Build a simple line-accumulator rather than using complex templating:

```java
public class CodeWriter {
    private final List<String> lines = new ArrayList<>();
    private int indent = 0;

    public CodeWriter line(String text) {
        lines.add("  ".repeat(indent) + text);
        return this;
    }

    public CodeWriter blank() {
        lines.add("");
        return this;
    }

    public CodeWriter comment(String text) {
        lines.add("// " + text);
        return this;
    }

    public CodeWriter indent() { indent++; return this; }
    public CodeWriter dedent() { indent = Math.max(0, indent - 1); return this; }

    public String getContent() {
        return String.join("\n", lines) + "\n";
    }

    public void write(FileManifest manifest, String path) {
        manifest.writeFile(path, getContent());
    }
}
```

**Why not use a template engine (Mustache, Handlebars, etc.)?**
Template engines add a dependency and make it harder to reason about control flow. For
codegen, imperative Java that builds strings is easier to test — each emitter method
is a plain function from model data to a string.

### 4.2 The Emitter Pattern

Split your generator into focused emitter classes, each responsible for one concern.
Every emitter gets the `Model` at construction time, then exposes `emit*(...)` methods:

```java
// ──────────────────────────────────────────────────────────────────────────────
// SchemaEmitter: Smithy shapes → target-language type/schema declarations
// ──────────────────────────────────────────────────────────────────────────────
public class SchemaEmitter {
    private final Model model;

    public SchemaEmitter(Model model) {
        this.model = model;
    }

    // Entry point: emit declarations for a list of root structures and all
    // shapes they transitively reference.
    public void emitDeclarations(Collection<StructureShape> roots, CodeWriter writer) {
        List<StructureShape> sorted = topologicalSort(roots);
        for (StructureShape shape : sorted) {
            if (shape.hasTrait(MixinTrait.class)) continue; // skip mixins
            emitOneDeclaration(shape, writer);
            writer.blank();
        }
    }

    private void emitOneDeclaration(StructureShape shape, CodeWriter writer) {
        boolean recursive = isRecursive(shape.getId());
        String schemaExpr = emitStructure(shape);
        // write `export const FooSchema = z.object({...})`
        // (use z.lazy() wrapper if recursive)
        ...
    }

    // Returns the schema expression for a single structure (no assignment)
    public String emitStructure(StructureShape shape) {
        StringBuilder sb = new StringBuilder("z.object({\n");
        for (Map.Entry<String, MemberShape> e : shape.getAllMembers().entrySet()) {
            String name = e.getKey();
            MemberShape member = e.getValue();
            Shape target = model.expectShape(member.getTarget());
            boolean required = member.hasTrait(RequiredTrait.class);
            String fieldExpr = emitShape(target, member);
            if (!required) fieldExpr += ".optional()";
            sb.append("  ").append(name).append(": ").append(fieldExpr).append(",\n");
        }
        sb.append("})");
        return sb.toString();
    }

    // Returns the schema expression for any shape
    public String emitShape(Shape shape, MemberShape member) {
        if (shape instanceof StringShape)    return emitString((StringShape) shape, member);
        if (shape instanceof IntegerShape)   return applyRange("z.number().int()", member);
        if (shape instanceof LongShape)      return applyRange("z.number().int()", member);
        if (shape instanceof FloatShape)     return "z.number()";
        if (shape instanceof DoubleShape)    return "z.number()";
        if (shape instanceof BooleanShape)   return "z.boolean()";
        if (shape instanceof TimestampShape) return "z.string().datetime()";
        if (shape instanceof BlobShape)      return "z.string()";
        if (shape instanceof StructureShape) return schemaVarName(shape.getId().getName());
        if (shape instanceof ListShape) {
            ListShape list = (ListShape) shape;
            Shape memberTarget = model.expectShape(list.getMember().getTarget());
            String inner = emitShape(memberTarget, null);
            if (list.hasTrait(SparseTrait.class)) inner += ".nullable()";
            return "z.array(" + inner + ")";
        }
        if (shape instanceof MapShape) {
            MapShape map = (MapShape) shape;
            Shape valueTarget = model.expectShape(map.getValue().getTarget());
            String valueExpr = emitShape(valueTarget, null);
            if (map.hasTrait(SparseTrait.class)) valueExpr += ".nullable()";
            return "z.record(z.string(), " + valueExpr + ")";
        }
        if (shape instanceof EnumShape) {
            EnumShape e = (EnumShape) shape;
            String values = e.getEnumValues().values().stream()
                .map(v -> "\"" + v + "\"").collect(Collectors.joining(", "));
            return "z.enum([" + values + "])";
        }
        return "z.unknown()";
    }
    ...
}
```

### 4.3 Topological Sort for Dependency-Ordered Declarations

When you emit `FooSchema = z.object({ bar: BarSchema })`, `BarSchema` must be declared
first. Use DFS post-order:

```java
private List<StructureShape> topologicalSort(Collection<StructureShape> roots) {
    Set<ShapeId> visited = new LinkedHashSet<>();
    List<StructureShape> result = new ArrayList<>();
    for (StructureShape root : roots) {
        visit(root, visited, result);
    }
    return result;
}

private void visit(StructureShape shape, Set<ShapeId> visited, List<StructureShape> result) {
    if (visited.contains(shape.getId())) return;
    visited.add(shape.getId());
    // Visit dependencies first (DFS)
    for (MemberShape member : shape.members()) {
        Shape target = model.expectShape(member.getTarget());
        if (target instanceof StructureShape dep && !dep.hasTrait(MixinTrait.class)) {
            visit(dep, visited, result);
        }
    }
    result.add(shape);
}
```

### 4.4 Handling Recursive Shapes

A shape that (transitively) references itself cannot be declared with a simple variable
assignment in most languages. Detect recursion with DFS cycle detection:

```java
private boolean isRecursive(ShapeId id) {
    return isRecursive(id, new HashSet<>());
}

private boolean isRecursive(ShapeId id, Set<ShapeId> visited) {
    if (!visited.add(id)) return true;
    Shape shape = model.expectShape(id);
    for (MemberShape m : shape.members()) {
        if (isRecursive(m.getTarget(), visited)) return true;
    }
    visited.remove(id);
    return false;
}
```

For TypeScript/Zod, wrap recursive schemas in `z.lazy()` AND emit an explicit,
hand-written type before the schema — `z.infer<typeof TreeNodeSchema>` cannot resolve
a `z.lazy` self-reference, so the type must be written out and the schema annotated with
`z.ZodType<TreeNode>`:
```typescript
export type TreeNode = {
  id: string;
  children?: TreeNode[];
}
export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() => z.object({
  id: z.string(),
  children: z.array(TreeNodeSchema).optional(),
}))
```

### 4.5 Shared Shapes Across Multiple Output Files

When generating one file per resource group, shapes referenced by multiple groups must
be emitted once to a shared file. The pattern:

```java
// 1. Compute which shapes each file needs (transitive closure)
Map<String, Set<ShapeId>> reachablePerGroup = computeReachablePerGroup(groups);

// 2. Shapes used by 2+ groups go to shared.gen.ts
Set<ShapeId> shared = reachablePerGroup.values().stream()
    .flatMap(Set::stream)
    .collect(Collectors.groupingBy(id -> id, Collectors.counting()))
    .entrySet().stream()
    .filter(e -> e.getValue() > 1)
    .map(Map.Entry::getKey)
    .collect(Collectors.toSet());

// 3. Each file excludes shared shapes from its declarations
//    but still REFERENCES them by name (they're imported from shared)
emitter.exclude(shared);
```

### 4.6 URI Conversion (Smithy → Framework)

Smithy uses `{paramName}` for path parameters. Most frameworks use a different convention
(`:paramName` for Express/Hono, `<param>` for Flask, etc.):

```java
// Example: convert to colon-style (Express, Hono, Axum)
private String smithyUriToFramework(String smithyUri) {
    return smithyUri.replaceAll("\\{(\\w+)\\}", ":$1");
}
```

Adapt the replacement string for your target framework's path parameter syntax.

### 4.7 HTTP Input Binding Resolution

Smithy explicitly annotates where each input field comes from:

```java
public enum HttpBinding { PATH, QUERY, HEADER, PAYLOAD, IMPLICIT_BODY, IMPLICIT_QUERY }

public static HttpBinding resolveBinding(MemberShape member, boolean hasBody) {
    if (member.hasTrait(HttpLabelTrait.class))   return HttpBinding.PATH;
    if (member.hasTrait(HttpQueryTrait.class))   return HttpBinding.QUERY;
    if (member.hasTrait(HttpHeaderTrait.class))  return HttpBinding.HEADER;
    if (member.hasTrait(HttpPayloadTrait.class)) return HttpBinding.PAYLOAD;
    // Implicit: if the HTTP method has a body (POST/PUT/PATCH), unbound fields
    // go to the JSON body; otherwise they're query parameters.
    return hasBody ? HttpBinding.IMPLICIT_BODY : HttpBinding.IMPLICIT_QUERY;
}

public static boolean isBodyMethod(String method) {
    return method.equals("POST") || method.equals("PUT") || method.equals("PATCH");
}
```

### 4.8 Writing Plugin Output Files

```java
@Override
public void execute(PluginContext context) {
    Model model = context.getModel();
    FileManifest manifest = context.getFileManifest();

    // Write a generated file
    manifest.writeFile("output.gen.ts", generatedContent);

    // Write using your CodeWriter
    CodeWriter writer = new CodeWriter();
    writer.line("export const foo = 42");
    writer.write(manifest, "constants.ts");
}
```

---

## 5. Custom Traits

Custom traits let users annotate their Smithy models with plugin-specific metadata.

### 5.1 Define the Trait in Smithy IDL

```smithy
// model/traits.smithy
$version: "2.0"
namespace com.myplugin

@trait(selector: "operation")
structure requiresAuth {
    permission: String
}
```

### 5.2 Implement in Java

```java
public final class RequiresAuthTrait extends AbstractTrait
        implements ToSmithyBuilder<RequiresAuthTrait> {

    public static final ShapeId ID = ShapeId.from("com.myplugin#requiresAuth");

    private final String permission;

    private RequiresAuthTrait(Builder builder) {
        super(ID, builder.getSourceLocation());
        this.permission = builder.permission;
    }

    public Optional<String> getPermission() {
        return Optional.ofNullable(permission);
    }

    @Override
    protected Node createNode() {
        ObjectNode.Builder b = Node.objectNodeBuilder();
        if (permission != null) b.withMember("permission", permission);
        return b.build();
    }

    @Override
    public Builder toBuilder() { return builder().permission(permission); }

    public static Builder builder() { return new Builder(); }

    public static final class Builder extends AbstractTraitBuilder<RequiresAuthTrait, Builder> {
        private String permission;
        public Builder permission(String p) { this.permission = p; return this; }
        @Override public RequiresAuthTrait build() { return new RequiresAuthTrait(this); }
    }

    // Provider: discovered by ServiceLoader, called when the model is assembled
    public static final class Provider extends AbstractTrait.Provider {
        public Provider() { super(ID); }

        @Override
        public RequiresAuthTrait createTrait(ShapeId target, Node value) {
            ObjectNode node = value.expectObjectNode();
            Builder b = builder().sourceLocation(value.getSourceLocation());
            node.getStringMember("permission").ifPresent(n -> b.permission(n.getValue()));
            return b.build();
        }
    }
}
```

### 5.3 Register the Provider

In `META-INF/services/software.amazon.smithy.model.traits.TraitService`:
```
com.myplugin.traits.RequiresAuthTrait$Provider
```

### 5.4 Load Trait Definitions in Tests

Tests that parse Smithy IDL with `@requiresAuth` need the trait definition file:
```java
Model model = Model.assembler()
    .addImport(getClass().getResource("/traits.smithy"))  // defines the trait shape
    .addUnparsedModel("test.smithy", smithyIdl)
    .assemble()
    .unwrap();
```

Copy your `model/traits.smithy` to `src/test/resources/traits.smithy`.

---

## 6. Settings / Configuration

Parse plugin settings from the `ObjectNode` delivered via `PluginContext.getSettings()`:

```java
public class MySettings {
    private final ShapeId service;
    private final String outputDirectory;

    private MySettings(ShapeId service, String outputDirectory) {
        this.service = service;
        this.outputDirectory = outputDirectory;
    }

    public static MySettings from(ObjectNode config) {
        ShapeId service = config.getStringMember("service")
            .map(s -> ShapeId.from(s.getValue()))
            .orElseThrow(() -> new IllegalArgumentException("'service' is required"));
        String outputDir = config.getStringMemberOrDefault("outputDirectory", "generated");
        return new MySettings(service, outputDir);
    }

    public ShapeId getService() { return service; }
    public String getOutputDirectory() { return outputDirectory; }
}
```

In `smithy-build.json`:
```json
{
  "version": "1.0",
  "sources": ["model"],
  "plugins": {
    "my-codegen": {
      "service": "com.example#MyService",
      "outputDirectory": "generated"
    }
  }
}
```

> **Caveat — `outputDirectory` does not relocate output under the Smithy Gradle plugin.**
> The Smithy Gradle plugin always writes a plugin's output under
> `build/smithyprojections/<project>/<projection>/<plugin-name>/` (e.g.
> `build/smithyprojections/smithy-hono/source/hono-codegen/`). Parsing an
> `outputDirectory` setting is fine — and consumers commonly set it — but it does
> NOT change where the Gradle build emits files; copying the generated tree to the
> consumer's `generated/` directory is a separate step (the examples copy it in by hand).
> If you want the setting to actually relocate files you must honor it yourself when
> calling `FileManifest.writeFile`.

---

## 7. Testing Strategy

This is where most plugin implementations fall short. A well-tested plugin uses four distinct
test layers. Each layer catches a different class of defect.

### 7.1 Unit Tests — Individual Emitters

Test each emitter class in isolation with inline model fragments.

**Pattern:**
```java
private static final String NS = "$version: \"2.0\"\nnamespace test\n";

private static Model modelFor(String smithy) {
    return Model.assembler()
        .addUnparsedModel("test.smithy", NS + smithy)
        .assemble()
        .unwrap();
}
```

**What to test:**

*SchemaEmitter tests:*
- Each primitive type emits the correct expression
- Constraint traits (length, pattern, range) produce the right chained calls
- Required members don't get `.optional()`, optional members do
- Nested structures reference the dependency by its schema variable name
- Enum shapes emit the correct union/enum expression
- Sparse list/map members are marked nullable
- Recursive shapes are wrapped in `z.lazy()` with explicit type annotation
- Mixin shapes are NOT emitted as standalone declarations
- Mixin members ARE inlined into concrete shapes
- `computeReachable()` includes all transitively reachable shapes

*RouteEmitter tests:*
- Operations interface has the correct `export interface` header
- Each operation has a method with the right input and return types
- Operations with no output return `Promise<void>`
- Router factory exports a function with the right signature
- Router registers routes at the correct HTTP method + path
- `hasAuthenticatedOps()` returns true/false based on trait presence

*ErrorEmitter tests:*
- Client error with `@httpError(N)` gets `$statusCode = N` and `$fault = 'client'`
- Server error with `@httpError(N)` gets `$statusCode = N` and `$fault = 'server'`
- Client error without `@httpError` defaults to 400
- Server error without `@httpError` defaults to 500
- Each error class `extends Error` and calls `Object.setPrototypeOf`
- Multiple errors are all emitted

*HttpBindings tests:*
- `@httpLabel` → PATH binding
- `@httpQuery` → QUERY binding
- `@httpHeader` → HEADER binding
- `@httpPayload` → PAYLOAD binding
- Un-annotated field on GET → IMPLICIT_QUERY
- Un-annotated field on POST → IMPLICIT_BODY
- POST/PUT/PATCH → `isBodyMethod` returns true; GET/DELETE → false
- Mixed bindings are split correctly across path/query/header/body maps

**Example:**
```java
@Test
void clientErrorWithHttpErrorGetsCorrectStatusCode() {
    Model m = modelFor(
        "@error(\"client\") @httpError(404)\n" +
        "structure NotFoundError { message: String }");
    RouteEmitter emitter = new RouteEmitter(m, null);
    CodeWriter writer = new CodeWriter();
    emitter.emitErrorClasses(List.of(
        m.expectShape(ShapeId.from("test#NotFoundError"), StructureShape.class)
    ), writer);
    String out = writer.getContent();
    assertTrue(out.contains("readonly $statusCode = 404"));
    assertTrue(out.contains("readonly $fault = 'client' as const"));
}
```

### 7.2 Snapshot Tests — Full Plugin Runs

Run the entire plugin end-to-end against fixture models and compare to committed expected files.
Snapshots catch regressions across ALL generated code — including parts not covered by unit tests.

**Pattern:**
```java
@ParameterizedTest(name = "{0} -> {2}")
@MethodSource("snapshotCases")
void matchesSnapshot(String modelFile, String serviceId, String expectedFile) throws Exception {
    Model model = Model.assembler()
        .addImport(getClass().getResource("/traits.smithy"))
        .addImport(getClass().getResource("/models/" + modelFile))
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

    new MyPlugin().execute(context);

    String actual = Files.readString(outputDir.resolve(expectedFile));

    boolean update = Boolean.getBoolean("UPDATE_SNAPSHOTS");
    Path snapshotPath = snapshotDir().resolve(modelFile.replace(".smithy", ""))
                                     .resolve(expectedFile);

    if (update) {
        Files.createDirectories(snapshotPath.getParent());
        Files.writeString(snapshotPath, actual);
    } else {
        String expected = Files.readString(snapshotPath);
        assertEquals(expected, actual,
            "Snapshot mismatch. Run: ./gradlew test -DUPDATE_SNAPSHOTS=true");
    }
}

static Stream<Arguments> snapshotCases() {
    return Stream.of(
        Arguments.of("basic-crud.smithy",     "com.test#CrudService",   "crud.gen.ts"),
        Arguments.of("edge-cases.smithy",     "com.test#EdgeService",   "edge.gen.ts"),
        Arguments.of("recursive-types.smithy","com.test#TreeService",   "tree.gen.ts")
    );
}
```

**Key design decisions:**
- Store snapshots in `src/test/resources/snapshots/` and commit them to git
- Add an `UPDATE_SNAPSHOTS` flag: `./gradlew test -DUPDATE_SNAPSHOTS=true`
- One snapshot per fixture model — cover different scenarios: basic CRUD, edge cases,
  recursive shapes, multiple resources, SSE events, etc.

### 7.3 Type-Check Test — Compile-Time Correctness of Generated Code

Snapshot tests confirm the text matches. Type-check tests confirm the generated code
actually compiles in its target language. This catches type errors that would appear at
runtime.

**Tag it `@Tag("slow")` and exclude from default runs:**

```java
@Tag("slow")
class TypeCheckTest {

    @Test
    void generatedFilesTypeCheck() throws Exception {
        // Run the plugin (or use pre-built output from smithyBuild).
        // Layout is build/smithyprojections/<project>/<projection>/<plugin-name>;
        // here <projection> defaults to "source" and the plugin name is its getName().
        Path sourceDir = Paths.get("build/smithyprojections/my-plugin/source/my-codegen");
        assertTrue(Files.exists(sourceDir), "Run ./gradlew smithyBuild first");

        // Copy generated files to a scratch directory with its own package.json/tsconfig
        Path typeCheckDir = Paths.get("typecheck");
        copyGeneratedFiles(sourceDir, typeCheckDir.resolve("generated"));

        // Run the compiler
        ProcessBuilder pb = new ProcessBuilder("npx", "tsc", "--noEmit")
            .directory(typeCheckDir.toFile())
            .redirectErrorStream(true);
        Process proc = pb.start();
        String output = new String(proc.getInputStream().readAllBytes());
        int exitCode = proc.waitFor();

        assertEquals(0, exitCode, "TypeScript compilation failed:\n" + output);
    }
}
```

In CI, run this explicitly:
```yaml
- name: Type-check generated TypeScript
  run: ./gradlew test -Dgroups=slow
```

For non-TypeScript targets, substitute the appropriate compiler (`rustc`, `mypy`, `tsc`, etc.).

### 7.4 Behavioral / Integration Tests — The Generated Code Actually Works

This is the most important layer. Instantiate the generated code, wire it to a real
in-memory server, and verify HTTP semantics end-to-end.

**Philosophy:** The behavioral tests must NOT mock the framework. They call the actual
generated router with real HTTP requests. Only the business-logic implementation (the
`ops` object) is a test double.

**What to cover:**
- Happy path for each operation (correct status code, correct body shape)
- Each error type (thrown errors map to the right status code and `code` field)
- Unexpected errors (non-domain errors → 500)
- Input validation (missing required field → 400, invalid format → 400)
- Auth: middleware is registered for protected routes, unprotected routes still work
- Auth: when middleware blocks, the protected route returns 401

**Example (TypeScript/Vitest):**
```typescript
// Create a minimal in-memory implementation
function makeOps(): MyOperations {
  const store = new Map<string, Item>()
  let seq = 0
  return {
    async CreateItem({ body }) {
      const item = { id: `id-${++seq}`, ...body }
      store.set(item.id, item)
      return { item }
    },
    async GetItem({ id }) {
      const item = store.get(id)
      if (!item) throw new NotFoundError(`${id} not found`)
      return { item }
    },
    // ...
  }
}

function makeApp(ops: MyOperations): Hono {
  const app = new Hono()
  app.route('/', createMyRouter(ops))
  return app
}

describe('GET /items/:id', () => {
  it('returns 200 with the item', async () => {
    const { ops } = makeOps()
    const { item } = await ops.CreateItem({ body: { name: 'Test' } })
    const res = await makeApp(ops).request(`/items/${item.id}`)
    expect(res.status).toBe(200)
    expect((await res.json() as any).item.name).toBe('Test')
  })

  it('returns 404 when not found', async () => {
    const res = await makeApp(makeOps()).request('/items/ghost')
    expect(res.status).toBe(404)
    expect((await res.json() as any).code).toBe('NotFoundError')
  })

  it('returns 500 for unexpected errors', async () => {
    const ops = { ...makeOps(), async GetItem() { throw new Error('db down') } }
    const res = await makeApp(ops).request('/items/x')
    expect(res.status).toBe(500)
  })
})
```

**Auth tests** (when the auth middleware is mockable):
```typescript
const { mockAuthMiddleware } = vi.hoisted(() => ({
  mockAuthMiddleware: vi.fn((_permission: string): MiddlewareHandler =>
    async (_c, next) => { await next() }   // default: passthrough
  ),
}))

vi.mock('../generated/middleware', () => ({
  authMiddleware: mockAuthMiddleware,
}))

describe('authMiddleware is registered with the correct permissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers "items.write" for POST /items', () => {
    makeApp()
    expect(mockAuthMiddleware).toHaveBeenCalledWith('items.write')
  })
})

describe('when authMiddleware blocks requests', () => {
  beforeEach(() => {
    mockAuthMiddleware.mockImplementation(() =>
      async (c) => c.json({ code: 'Unauthorized' }, 401)
    )
  })

  it('POST /items returns 401', async () => {
    const res = await makeApp().request('/items', { method: 'POST', ... })
    expect(res.status).toBe(401)
  })

  it('GET /items is still accessible', async () => {
    const res = await makeApp().request('/items')
    expect(res.status).toBe(200)
  })
})
```

### 7.5 Fixture Models to Cover

Create one Smithy model per scenario:

| File | Covers |
|---|---|
| `basic-crud.smithy` | GET/POST/DELETE with `@httpLabel`, `@httpQuery`, `@httpPayload` |
| `mixed-bindings.smithy` | All four bindings (path + query + header + body) in one operation |
| `error-shapes.smithy` | Multiple error types, service-level vs operation-level errors |
| `recursive-types.smithy` | Self-referencing structures (tree/linked list) |
| `sse-events.smithy` | Shapes with your custom `@sseEvent` trait |
| `multi-resource.smithy` | Two resources that share a common shape → shared.gen.ts |

### 7.6 Gradle Integration Task

Wire the behavioral tests into `./gradlew check`:

```kotlin
tasks.register("exampleIntegTest") {
    description = "Runs vitest behavioral tests for the example"
    group = "verification"
    dependsOn("smithyBuild")
    doLast {
        exec {
            workingDir("examples/my-example")
            commandLine("npm", "run", "test")
        }
    }
}

tasks.named("check") {
    dependsOn("exampleIntegTest")
}
```

---

## 8. Publishing

### 8.1 Maven Local (for local development)

```bash
./gradlew publishToMavenLocal
```

Then in the consumer project's `build.gradle.kts`:
```kotlin
repositories { mavenLocal(); mavenCentral() }
dependencies {
    smithyBuild("com.myplugin:my-plugin:0.1.0")
}
```

### 8.2 Maven Central / GitHub Packages

Add signing and repository config to `build.gradle.kts`:

```kotlin
plugins {
    signing
    `maven-publish`
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            pom {
                name.set("my-plugin")
                description.set("Smithy codegen plugin for ...")
                url.set("https://github.com/yourorg/my-plugin")
                licenses { license { name.set("MIT") } }
                developers { developer { name.set("Your Name") } }
                scm { url.set("https://github.com/yourorg/my-plugin") }
            }
        }
    }
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/yourorg/my-plugin")
            credentials {
                username = System.getenv("GITHUB_ACTOR")
                password = System.getenv("GITHUB_TOKEN")
            }
        }
    }
}

signing {
    sign(publishing.publications["maven"])
}
```

---

## 9. CI Configuration

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit-and-snapshot-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: gradle

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: examples/my-example/package-lock.json

      - name: Run unit, snapshot, and behavioral tests
        run: ./gradlew check

      - name: Upload test report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-report
          path: build/reports/tests/test/

  type-check:
    runs-on: ubuntu-latest
    needs: unit-and-snapshot-tests
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: gradle

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build and type-check generated code
        run: ./gradlew smithyBuild && ./gradlew test -Dgroups=slow
```

---

## 10. Generalizing to Any Target Language

The examples in this guide use TypeScript/Hono/Zod as a concrete target. The architecture pattern applies to any target language or framework.

### 10.1 What Changes Per Language

| Concern | TypeScript/Hono | Rust/Axum | Python/FastAPI | Go/net-http |
|---|---|---|---|---|
| Type declarations | Zod schemas + TS types | Serde structs | Pydantic models | Go structs |
| Schema variable naming | `FooSchema`, `type Foo` | `Foo` (derives) | `class Foo(BaseModel)` | `type Foo struct` |
| Recursive handling | `z.lazy()` | `Box<T>` on fields | Forward reference | N/A |
| Route registration | `app.get(path, ...)` | `Router::new().route(...)` | `@app.get(path)` | `mux.HandleFunc(...)` |
| Error handling | `instanceof` checks | `match` on error type | `HTTPException` | `errors.Is` |
| HTTP binding extraction | `c.req.valid('param')` | `Path(id)`, `Query(q)` | `Depends()`, path arg | `r.PathValue("id")` |

### 10.2 What Stays the Same

- Plugin entry point: `SmithyBuildPlugin.execute(PluginContext)`
- Model navigation: `Model`, `TopDownIndex`, `ServiceShape`, shape type hierarchy
- Trait reading: `shape.hasTrait(...)`, `shape.expectTrait(...)`
- File writing: `FileManifest.writeFile(path, content)`
- ServiceLoader registration: `META-INF/services/...`
- Testing pattern: unit → snapshot → compile-check → behavioral

### 10.3 FileWriter is Language-Agnostic

The `CodeWriter` (line accumulator with indent) works for any language. Adapt the
`comment()` method to use `#`, `//`, `--`, etc. as appropriate.

### 10.4 Naming Convention Conflicts

Every language has reserved words and naming rules. Build a `safeTypeName()` function:

```java
private static final Set<String> RESERVED = Set.of(
    "Error", "Object", "Array", "String", "Number", // TypeScript
    "type", "struct", "interface", "func",           // Go
    "class", "def", "import", "from", "pass"         // Python
);

public static String safeTypeName(String name) {
    return RESERVED.contains(name) ? name + "Shape" : name;
}
```

### 10.5 End-to-End Test Pattern is Universal

Regardless of language, the behavioral test pattern is:
1. Create a minimal in-memory implementation of the generated interface
2. Mount it on the generated router
3. Fire HTTP requests against it
4. Assert status codes and response bodies

The language changes; the intent doesn't.

---

## 11. Quick Reference: Smithy to Target-Language Type Mappings

| Smithy Type | TypeScript/Zod | Python/Pydantic | Go | Rust |
|---|---|---|---|---|
| `string` | `z.string()` | `str` | `string` | `String` |
| `integer` | `z.number().int()` | `int` | `int32` / `int` | `i32` |
| `long` | `z.number().int()` | `int` | `int64` | `i64` |
| `float` | `z.number()` | `float` | `float32` | `f32` |
| `double` | `z.number()` | `float` | `float64` | `f64` |
| `boolean` | `z.boolean()` | `bool` | `bool` | `bool` |
| `timestamp` | `z.string().datetime()` | `datetime` | `time.Time` | `DateTime<Utc>` |
| `blob` | `z.string()` | `bytes` | `[]byte` | `Vec<u8>` |
| `list<T>` | `z.array(T)` | `list[T]` | `[]T` | `Vec<T>` |
| `map<K,V>` | `z.record(K, V)` | `dict[K, V]` | `map[K]V` | `HashMap<K,V>` |
| `enum` | `z.enum([...])` | `Enum` subclass | `string` + consts | `enum` |

---

## 12. Checklist Before Shipping

- [ ] Plugin name in `getName()` matches the key in `smithy-build.json`
- [ ] `META-INF/services/software.amazon.smithy.build.SmithyBuildPlugin` registered
- [ ] Custom trait `TraitService` entries registered (if applicable)
- [ ] `afterEvaluate` block adds plugin classes to `smithyBuild` configuration
- [ ] `smithyBuild` task depends on `compileJava` and `processResources`
- [ ] Unit tests cover all shape types and constraint traits
- [ ] Snapshot tests cover: basic CRUD, mixed bindings, errors, recursive shapes
- [ ] `UPDATE_SNAPSHOTS` flag works: `./gradlew test -DUPDATE_SNAPSHOTS=true`
- [ ] Type-check test tagged `@Tag("slow")` and excluded from default run
- [ ] Behavioral tests hit each operation's happy path + error cases + 500 for unknown errors
- [ ] Behavioral auth tests verify: correct permission registered, middleware can block, unprotected routes unaffected
- [ ] `./gradlew check` runs unit + snapshot + behavioral tests
- [ ] CI runs `check` on every PR
- [ ] CI separately runs type-check test against freshly generated output
- [ ] Published artifact includes: compiled `.jar`, sources, and Javadoc

---

## 13. Reference: Suggested Source Map

When implementing your plugin, organize files with roughly these responsibilities:

| File | What it teaches |
|---|---|
| `src/main/java/.../MyPlugin.java` | Full plugin `execute()` method: grouping, shared shape detection, file orchestration |
| `src/main/java/.../MySettings.java` | Minimal settings parsing from `ObjectNode` |
| `src/main/java/.../ModelIndex.java` | Helper methods for common model queries |
| `src/main/java/.../writers/SchemaEmitter.java` | Canonical shape → target-language type expression mapping |
| `src/main/java/.../writers/SchemaDeclarationEmitter.java` | Topological sort, recursive detection, `computeReachable()` |
| `src/main/java/.../writers/InputBindings.java` | HTTP binding resolution |
| `src/main/java/.../writers/RouteEmitter.java` | Route factory, operations interface, error classes |
| `src/main/java/.../traits/MyCustomTrait.java` | Full custom trait with Provider |
| `src/test/java/.../SnapshotTest.java` | Parameterized snapshot test with `UPDATE_SNAPSHOTS` |
| `src/test/java/.../SchemaEmitterTest.java` | Unit tests for every Smithy shape type |
| `src/test/java/.../HttpBindingsTest.java` | Unit tests for binding resolution |
| `src/test/java/.../EdgeCasesTest.java` | Recursive shapes, mixins, sparse collections |
| `src/test/java/.../TypeCheckTest.java` | Slow compile-check test (tagged, excluded by default) |
| `examples/my-example/test/behavior.test.*` | Behavioral tests: status codes, validation, error classes |
| `examples/my-example/test/auth.test.*` | Auth middleware registration + blocking tests |
| `build.gradle.kts` | Complete Gradle config including `afterEvaluate` classloader fix |
| `.github/workflows/test.yml` | CI: fast tests + slow type-check in separate job |
