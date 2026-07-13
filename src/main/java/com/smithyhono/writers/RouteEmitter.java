package com.smithyhono.writers;

import com.smithyhono.ModelIndex;
import com.smithyhono.traits.RequiresAuthTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.*;
import software.amazon.smithy.model.traits.*;

import java.util.*;

public class RouteEmitter {
    private final Model model;
    private final ModelIndex index;
    private final ZodEmitter zodEmitter;

    public RouteEmitter(Model model, ModelIndex index) {
        this.model = model;
        this.index = index;
        this.zodEmitter = new ZodEmitter(model);
    }

    // ── Error classes ─────────────────────────────────────────────────────────

    public void emitErrorClasses(Collection<StructureShape> errors, TypeScriptFileWriter writer) {
        for (StructureShape error : errors) {
            emitErrorClass(error, writer);
        }
    }

    private void emitErrorClass(StructureShape errorShape, TypeScriptFileWriter writer) {
        String name = errorShape.getId().getName();
        int statusCode = getErrorStatusCode(errorShape);
        String fault = errorShape.expectTrait(ErrorTrait.class).getValue();

        writer.line("export class " + name + " extends Error {")
              .line("  readonly $statusCode = " + statusCode)
              .line("  readonly $fault = '" + fault + "' as const");
        // @retryable → carry a retry hint on the modeled error so generated
        // clients back off and retry correctly (RATE-02). @retryable(throttling:
        // true) additionally marks the 429-class throttling errors (e.g.
        // ThrottlingException) the rate limiter returns.
        if (errorShape.hasTrait(RetryableTrait.class)) {
            writer.line("  readonly $retryable = true as const");
            if (errorShape.expectTrait(RetryableTrait.class).getThrottling()) {
                writer.line("  readonly $throttling = true as const");
            }
        }
        writer.line("  constructor(message: string) {")
              .line("    super(message)")
              .line("    this.name = '" + name + "'")
              .line("    Object.setPrototypeOf(this, " + name + ".prototype)")
              .line("  }")
              .line("}")
              .blank();
    }

    private int getErrorStatusCode(StructureShape errorShape) {
        if (errorShape.hasTrait(HttpErrorTrait.class)) {
            return errorShape.expectTrait(HttpErrorTrait.class).getCode();
        }
        String fault = errorShape.expectTrait(ErrorTrait.class).getValue();
        return fault.equals("client") ? 400 : 500;
    }

    // ── Operations interface ─────────────────────────────────────────────────

    public void emitOperationsInterface(String interfaceName, List<OperationShape> ops,
                                        TypeScriptFileWriter writer) {
        writer.line("export interface " + interfaceName + " {");
        for (OperationShape op : ops) {
            String opName = op.getId().getName();
            String inputType = buildInputType(op);
            String outputType = buildOutputType(op);
            writer.line("  " + opName + "(input: " + inputType + ", c?: Context<SecurityEnv>): Promise<" + outputType + ">");
        }
        writer.line("}");
        writer.blank();
    }

    // Type rendering lives in OperationTypes so the generated client's method
    // signatures match this operations interface byte-for-byte (no drift).
    private String buildInputType(OperationShape op) {
        return OperationTypes.inputType(model, index, op);
    }

    private String buildOutputType(OperationShape op) {
        return OperationTypes.outputType(index, op);
    }

    public void emitEnvType(String envTypeName, TypeScriptFileWriter writer) {
        writer.line("export type " + envTypeName + " = { Variables: SecurityVariables }");
        writer.blank();
    }

    public void emitMiddlewareInterface(String middlewareInterfaceName, List<OperationShape> ops,
                                        TypeScriptFileWriter writer) {
        writer.line("export interface " + middlewareInterfaceName + " {");
        writer.line("  all?: MiddlewareHandler[]");
        for (OperationShape op : ops) {
            writer.line("  " + op.getId().getName() + "?: MiddlewareHandler[]");
        }
        writer.line("}");
        writer.blank();
    }

    // ── Auth helpers ──────────────────────────────────────────────────────────

    public boolean hasAuthenticatedOps(List<OperationShape> ops) {
        return ops.stream().anyMatch(op -> op.hasTrait(RequiresAuthTrait.class));
    }

    /**
     * Whether the operation gets a post-deserialization {@code authorize(OPERATIONS.x)}
     * hook (Phase S2). True when the op declares required permissions OR carries a
     * non-anonymous auth scheme — i.e. anything an authenticated principal must reach
     * before the handler runs. Anonymous-only / no-auth ops get no hook.
     */
    public boolean needsAuthorize(OperationShape op) {
        if (index.requiredPermissionFor(op).isPresent()) return true;
        List<String> schemes = index.authSchemesFor(op);
        return schemes.stream().anyMatch(s -> !s.equals("anonymous"));
    }

    /** True when any operation in the group needs the {@code authorize} import (S2). */
    public boolean hasAuthorizedOps(List<OperationShape> ops) {
        return ops.stream().anyMatch(this::needsAuthorize);
    }

    /**
     * True when any operation in the group has an output member bound to
     * {@code @httpResponseCode} (CG-06) — so the file imports the Hono
     * {@code ContentfulStatusCode} type to cast the dynamic status.
     */
    public boolean hasDynamicStatusOps(List<OperationShape> ops) {
        return ops.stream().anyMatch(op ->
            index.getOutput(op)
                .map(out -> out.getAllMembers().values().stream()
                    .anyMatch(m -> m.hasTrait(HttpResponseCodeTrait.class)))
                .orElse(false));
    }

    // ── Router factory ────────────────────────────────────────────────────────

    public void emitRouterFactory(String routerFunctionName, String interfaceName,
                                   String middlewareInterfaceName, List<OperationShape> ops,
                                   TypeScriptFileWriter writer) {
        // _chain folds an array of MiddlewareHandler into a single MiddlewareHandler so it
        // fits as one element in Hono's static tuple overloads — spreading MiddlewareHandler[]
        // directly breaks Hono's TypeScript inference because HandlerInterface uses explicit
        // per-arity overloads rather than a variadic signature.
        writer.line("function _chain(mws: MiddlewareHandler[]): MiddlewareHandler {");
        writer.line("  return async (c, next) => {");
        writer.line("    let i = 0");
        writer.line("    const run = async (): Promise<void> => { i < mws.length ? await mws[i++](c, run) : await next() }");
        writer.line("    await run()");
        writer.line("  }");
        writer.line("}");
        writer.blank();
        writer.line("export function " + routerFunctionName + "(ops: " + interfaceName + ", middleware?: " + middlewareInterfaceName + "): Hono {");
        writer.line("  const app = new Hono()");
        writer.blank();

        for (OperationShape op : ops) {
            if (op.hasTrait(HttpTrait.class)) {
                emitRoute(op, writer);
            }
        }

        writer.line("  return app");
        writer.line("}");
    }

    private void emitRoute(OperationShape op, TypeScriptFileWriter writer) {
        HttpTrait http = op.expectTrait(HttpTrait.class);
        String method = http.getMethod().toLowerCase();
        String path = index.smithyUriToHono(http.getUri().toString());
        int successCode = http.getCode();
        String opName = op.getId().getName();

        Optional<StructureShape> outputOpt = index.getOutput(op);
        boolean hasOutput = outputOpt.isPresent() && !outputOpt.get().getAllMembers().isEmpty();

        // Comment: @http and optional @requiresAuth. The @http method/uri come from
        // Smithy's built-in trait (validated against the http grammar — no newlines), but
        // the @requiresAuth permission is unconstrained model-author free text, so it is
        // escaped before being concatenated into the single-line // comment. Otherwise a
        // newline in the permission would terminate the comment and turn the trailing
        // bytes into live code on the next line of the generated module (CODEGEN-EMIT-2-05).
        writer.line("  // @http(method: \"" + http.getMethod() + "\", uri: \"" + http.getUri() + "\")");
        if (op.hasTrait(RequiresAuthTrait.class)) {
            RequiresAuthTrait authTrait = op.expectTrait(RequiresAuthTrait.class);
            String permComment = authTrait.getPermission()
                .map(p -> "(permission: " + TypeScriptFileWriter.stringLiteral(p) + ")")
                .orElse("");
            writer.line("  // @requiresAuth" + permComment);
        }

        // Compute bindings once — reused for both the validator chain and input assembly.
        InputBindings bindings = index.getInput(op)
            .map(input -> new InputBindings(input, http.getMethod()))
            .orElse(null);

        // Build middleware chain: user middleware wrapped in _chain, then validators, then
        // the op-tier authorize() hook. Hono's HandlerInterface uses explicit per-arity tuple
        // overloads, not a variadic signature, so spreading MiddlewareHandler[] directly breaks
        // TypeScript type inference. _chain collapses the user-supplied arrays into a single
        // typed MiddlewareHandler that fits the overloads.
        List<String> middlewares = new ArrayList<>();
        middlewares.add("_chain([...(middleware?.all ?? []), ...(middleware?." + opName + " ?? [])])");
        middlewares.addAll(buildValidatorChain(bindings));
        // Post-deserialization operation-tier authZ (Phase S2): emitted last, after
        // the validators + app-middleware spreads and immediately before the handler,
        // so it runs on validated input with the pipeline-resolved principal in context.
        if (needsAuthorize(op)) {
            middlewares.add("authorize(OPERATIONS." + opName + ")");
        }

        StringBuilder route = new StringBuilder("  app." + method + "('" + path + "'");
        for (String mw : middlewares) {
            route.append(",\n    ").append(mw);
        }
        route.append(",\n    async (c) => {");
        writer.line(route.toString());

        writer.line("      " + buildInputAssembly(bindings));
        writer.line("      try {");

        if (hasOutput) {
            emitSuccessResponse(outputOpt.get(), opName, successCode, writer);
        } else {
            writer.line("        await ops." + opName + "(input, c as unknown as Context<SecurityEnv>)");
            writer.line("        return c.body(null, " + successCode + ")");
        }

        emitCatchBlock(op, writer);

        writer.line("    }");
        writer.line("  )");
        writer.blank();
    }

    // ── Validator chain ───────────────────────────────────────────────────────

    private List<String> buildValidatorChain(InputBindings bindings) {
        if (bindings == null) return List.of();

        List<String> validators = new ArrayList<>();
        // Path/query/header values arrive as STRINGS on the wire (CG-01), so their
        // validators coerce. JSON body members stay strict (no coercion).
        if (!bindings.pathMembers.isEmpty())
            validators.add(buildInlineValidator("param", bindings.pathMembers, true));
        if (!bindings.queryMembers.isEmpty())
            validators.add(buildInlineValidator("query", bindings.queryMembers, true));
        if (!bindings.headerMembers.isEmpty())
            validators.add(buildHeaderValidator(bindings.headerMembers));
        if (!bindings.bodyMembers.isEmpty()) {
            if (bindings.hasPayload()) {
                MemberShape payloadMember = bindings.bodyMembers.get(bindings.payloadMemberName);
                Shape targetShape = model.expectShape(payloadMember.getTarget());
                String schemaExpr = (targetShape instanceof StructureShape)
                    ? ZodEmitter.schemaVarName(targetShape.getId().getName())
                    : zodEmitter.emitShape(targetShape, payloadMember);
                validators.add(buildPayloadValidator(schemaExpr));
            } else {
                validators.add(buildInlineValidator("json", bindings.bodyMembers, false));
            }
        }
        return validators;
    }

    private String buildInlineValidator(String target, Map<String, MemberShape> members, boolean coercing) {
        StringBuilder schema = new StringBuilder("z.object({\n");
        for (Map.Entry<String, MemberShape> entry : members.entrySet()) {
            String name = entry.getKey();
            MemberShape member = entry.getValue();
            Shape targetShape = model.expectShape(member.getTarget());
            String zodExpr = zodEmitter.emitShape(targetShape, member, coercing);
            if (!member.hasTrait(RequiredTrait.class)) zodExpr += ".optional()";
            schema.append("      ").append(ZodEmitter.tsKey(name)).append(": ").append(zodExpr).append(",\n");
        }
        // The inline JSON body validator rejects unknown keys (VAL-03), matching the
        // .strict() policy named struct schemas already enforce (CG-EMIT-1-06). Path
        // (param) and query validators stay non-strict: extra query params are benign
        // and path keys are fixed by the route pattern, so strictness there would only
        // reject legitimate traffic.
        schema.append(target.equals("json") ? "    }).strict()" : "    })");
        return "zValidator('" + target + "', " + schema + ", " + onValidationError() + ")";
    }

    /**
     * The shared zValidator onError callback (VAL-08). Maps Zod issues to
     * {@code { path, code }[]} only — field paths, never the raw invalid value —
     * so a validation failure can't echo attacker-supplied (or sensitive) values.
     */
    private static String onValidationError() {
        return "(result, c) => {\n" +
               "      if (!result.success)\n" +
               "        return c.json({ code: 'ValidationException', fieldErrors: result.error.issues.map(i => ({ path: i.path.join('.'), code: i.code })) }, 400)\n" +
               "    }";
    }

    // Header validator uses the lowercased wire name as the Zod schema key, not the member name.
    private String buildHeaderValidator(Map<String, MemberShape> members) {
        StringBuilder schema = new StringBuilder("z.object({\n");
        for (Map.Entry<String, MemberShape> entry : members.entrySet()) {
            MemberShape member = entry.getValue();
            String wireName = member.expectTrait(HttpHeaderTrait.class).getValue().toLowerCase();
            Shape targetShape = model.expectShape(member.getTarget());
            // Headers arrive as strings (CG-01) — coerce non-string targets.
            String zodExpr = zodEmitter.emitShape(targetShape, member, true);
            if (!member.hasTrait(RequiredTrait.class)) zodExpr += ".optional()";
            schema.append("      ").append(ZodEmitter.jsSingleQuoted(wireName)).append(": ").append(zodExpr).append(",\n");
        }
        schema.append("    })");
        return "zValidator('header', " + schema + ", " + onValidationError() + ")";
    }

    private String buildPayloadValidator(String schemaExpr) {
        return "zValidator('json', " + schemaExpr + ", " + onValidationError() + ")";
    }

    // ── Input assembly ────────────────────────────────────────────────────────

    private String buildInputAssembly(InputBindings bindings) {
        if (bindings == null) return "const input = {}";

        List<String> parts = new ArrayList<>();
        if (!bindings.pathMembers.isEmpty())
            parts.add("...c.req.valid('param')");
        if (!bindings.queryMembers.isEmpty())
            parts.add("...c.req.valid('query')");
        // Headers cannot be blindly spread: the wire name (kebab-case) differs from
        // the member name (camelCase), so each header is individually mapped. Read
        // from the VALIDATED header bag (not c.req.header()) so coerced non-string
        // values (CG-01) reach the handler with their declared type.
        for (Map.Entry<String, MemberShape> entry : bindings.headerMembers.entrySet()) {
            String memberName = entry.getKey();
            String wireName = entry.getValue().expectTrait(HttpHeaderTrait.class).getValue().toLowerCase();
            parts.add(memberName + ": c.req.valid('header')[" + ZodEmitter.jsSingleQuoted(wireName) + "]");
        }
        // CG-05 — @httpQueryParams: the full query map MINUS params already bound to
        // explicit @httpQuery members.
        for (String memberName : bindings.queryParamsMembers.keySet()) {
            parts.add(memberName + ": " + queryParamsExpr(bindings.queryMembers));
        }
        // CG-05 — @httpPrefixHeaders("x-meta-"): headers matching the prefix, with the
        // prefix stripped from each key.
        for (Map.Entry<String, MemberShape> entry : bindings.prefixHeadersMembers.entrySet()) {
            String prefix = entry.getValue().expectTrait(HttpPrefixHeadersTrait.class).getValue().toLowerCase();
            parts.add(entry.getKey() + ": Object.fromEntries(Object.entries(c.req.header())"
                + ".filter(([k]) => k.startsWith(" + ZodEmitter.jsSingleQuoted(prefix) + ")).map(([k, v]) => [k.slice(" + prefix.length() + "), v]))");
        }
        if (!bindings.bodyMembers.isEmpty()) {
            if (bindings.hasPayload())
                parts.add(bindings.payloadMemberName + ": c.req.valid('json')");
            else
                parts.add("...c.req.valid('json')");
        }

        if (parts.isEmpty()) return "const input = {}";
        if (parts.size() == 1) return "const input = { " + parts.get(0) + " }";
        return "const input = {\n        " + String.join(",\n        ", parts) + "\n      }";
    }

    /**
     * CG-05 — the input-assembly expression for an {@code @httpQueryParams} member:
     * the full query map, minus the wire names already bound to explicit
     * {@code @httpQuery} members (which are surfaced as their own typed fields).
     */
    private static String queryParamsExpr(Map<String, MemberShape> queryMembers) {
        List<String> explicit = new ArrayList<>();
        for (MemberShape m : queryMembers.values()) {
            explicit.add(ZodEmitter.jsSingleQuoted(m.expectTrait(HttpQueryTrait.class).getValue()));
        }
        if (explicit.isEmpty()) return "c.req.query()";
        return "Object.fromEntries(Object.entries(c.req.query()).filter(([k]) => !["
            + String.join(", ", explicit) + "].includes(k)))";
    }

    // ── Success response (output bindings, CG-06) ───────────────────────────────

    /**
     * Emits the success path. Output members bound to {@code @httpResponseCode} drive
     * the HTTP status; output {@code @httpHeader} members are written as response
     * headers; both are EXCLUDED from the JSON body (CG-06 — previously they leaked
     * into the body and the status was always the static {@code @http} code).
     */
    private void emitSuccessResponse(
            StructureShape output, String opName, int successCode, TypeScriptFileWriter writer) {
        writer.line("        const result = await ops." + opName + "(input, c as unknown as Context<SecurityEnv>)");

        String statusMember = null;
        List<Map.Entry<String, String>> headerMembers = new ArrayList<>(); // memberName -> wireName
        for (Map.Entry<String, MemberShape> entry : output.getAllMembers().entrySet()) {
            MemberShape m = entry.getValue();
            if (m.hasTrait(HttpResponseCodeTrait.class)) {
                statusMember = entry.getKey();
            } else if (m.hasTrait(HttpHeaderTrait.class)) {
                headerMembers.add(Map.entry(entry.getKey(), m.expectTrait(HttpHeaderTrait.class).getValue()));
            }
        }

        if (statusMember == null && headerMembers.isEmpty()) {
            writer.line("        return c.json(result, " + successCode + ")");
            return;
        }

        // Pull the status/header members out of the body via destructuring.
        List<String> bound = new ArrayList<>();
        if (statusMember != null) bound.add(statusMember);
        for (Map.Entry<String, String> h : headerMembers) bound.add(h.getKey());
        writer.line("        const { " + String.join(", ", bound) + ", ...__body } = result");

        for (Map.Entry<String, String> h : headerMembers) {
            writer.line("        if (" + h.getKey() + " !== undefined) c.header("
                + ZodEmitter.jsSingleQuoted(h.getValue()) + ", String(" + h.getKey() + "))");
        }

        if (statusMember != null) {
            // A dynamic @httpResponseCode is a plain number; Hono's c.json(body, n)
            // wants a StatusCode literal, so cast it to the Hono status type.
            writer.line("        return c.json(__body, (" + statusMember + " ?? " + successCode
                + ") as ContentfulStatusCode)");
        } else {
            writer.line("        return c.json(__body, " + successCode + ")");
        }
    }

    // ── Catch block ───────────────────────────────────────────────────────────

    private void emitCatchBlock(OperationShape op, TypeScriptFileWriter writer) {
        writer.line("      } catch (e) {");
        for (StructureShape error : index.getAllErrors(op)) {
            String name = error.getId().getName();
            writer.line("        if (e instanceof " + name + ")")
                  .line("          return c.json({ code: '" + name
                        + "', message: e.message }, e.$statusCode)");
        }
        writer.line("        return c.json({ code: 'InternalServerError', message: 'Internal server error' }, 500)");
        writer.line("      }");
    }
}
