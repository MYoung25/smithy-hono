package com.smithyhono;

import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;

public class HonoSettings {
    private final ShapeId service;
    private final String outputDirectory;
    private final String securityCoreImport;
    private final String packageName;
    private final String packageVersion;
    private final int defaultMaxPageSize;
    private final int defaultPageSize;
    private final boolean emitClient;
    private final boolean enforceResourceScoping;

    private HonoSettings(ShapeId service, String outputDirectory,
                         String securityCoreImport, String packageName, String packageVersion,
                         int defaultMaxPageSize, int defaultPageSize, boolean emitClient,
                         boolean enforceResourceScoping) {
        this.service = service;
        this.outputDirectory = outputDirectory;
        this.securityCoreImport = securityCoreImport;
        this.packageName = packageName;
        this.packageVersion = packageVersion;
        this.defaultMaxPageSize = defaultMaxPageSize;
        this.defaultPageSize = defaultPageSize;
        this.emitClient = emitClient;
        this.enforceResourceScoping = enforceResourceScoping;
    }

    public static HonoSettings from(ObjectNode config) {
        ShapeId service = config.getStringMember("service")
            .map(s -> ShapeId.from(s.getValue()))
            .orElseThrow(() -> new IllegalArgumentException("hono-codegen requires 'service' setting"));

        String outputDir = config.getStringMemberOrDefault("outputDirectory", "generated");
        // The runtime security package that exports the `authorize` op-tier hook (Phase S2).
        String securityCoreImport = config.getStringMemberOrDefault("securityCoreImport", "@smithy-hono/security-core");
        String packageName = config.getStringMemberOrDefault("packageName", "smithy-hono-generated");
        String packageVersion = config.getStringMemberOrDefault("packageVersion", "0.1.0");

        // RATE-06 fallback caps, used only when a @paginated op declares no @range(max:).
        int defaultMaxPageSize = config.getNumberMember("defaultMaxPageSize")
            .map(n -> n.getValue().intValue()).orElse(100);
        int defaultPageSize = config.getNumberMember("defaultPageSize")
            .map(n -> n.getValue().intValue()).orElse(25);

        // Emit a typed fetch client (<stem>.client.gen.ts) alongside the router.
        // On by default — additive, Web-standard only; set false to opt out.
        boolean emitClient = config.getBooleanMemberOrDefault("emitClient", true);

        // Opt-in strict enforcement (AUTHZ-01 / CODEGEN-EMIT-2-06). Default OFF — when true,
        // a @persisted resource that is authenticated but declares no owner/tenant scoping
        // (and is not marked allowUnscoped) FAILS the build instead of only warning.
        boolean enforceResourceScoping =
            config.getBooleanMemberOrDefault("enforceResourceScoping", false);

        return new HonoSettings(service, outputDir, securityCoreImport,
            packageName, packageVersion, defaultMaxPageSize, defaultPageSize, emitClient,
            enforceResourceScoping);
    }

    public ShapeId getService() { return service; }
    public String getOutputDirectory() { return outputDirectory; }
    public String getSecurityCoreImport() { return securityCoreImport; }
    public String getPackageName() { return packageName; }
    public String getPackageVersion() { return packageVersion; }
    public int getDefaultMaxPageSize() { return defaultMaxPageSize; }
    public int getDefaultPageSize() { return defaultPageSize; }
    public boolean isEmitClient() { return emitClient; }
    public boolean isEnforceResourceScoping() { return enforceResourceScoping; }
}
