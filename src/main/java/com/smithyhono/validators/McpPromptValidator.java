package com.smithyhono.validators;

import com.smithyhono.ModelIndex;
import com.smithyhono.traits.McpPromptsTrait;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.validation.AbstractValidator;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plan 14 (§12.6): validates {@code @mcpPrompts} on services and operations. Prompts are
 * hand-authored, so the value of declaring them in the model (over a static JSON file) is
 * exactly that the build can catch authoring mistakes — a placeholder referencing an
 * argument that doesn't exist, a duplicate name that would collide in {@code prompts/list},
 * etc. — at {@code gradle build} time rather than at {@code prompts/get} time.
 *
 * <p>Only fires for shapes carrying {@code @mcpPrompts}; everything else is unaffected.
 *
 * <table>
 *   <tr><th>Check</th><th>Severity</th></tr>
 *   <tr><td>Duplicate effective prompt names within a service</td><td>ERROR</td></tr>
 *   <tr><td>Service-level prompt with no {@code name}</td><td>ERROR</td></tr>
 *   <tr><td>Placeholder references an undeclared/underivable argument</td><td>ERROR</td></tr>
 *   <tr><td>Argument-name collision within one prompt</td><td>ERROR</td></tr>
 *   <tr><td>Empty/whitespace {@code name} or {@code template}</td><td>ERROR</td></tr>
 *   <tr><td>Unbalanced braces / non-identifier placeholder chars</td><td>WARNING</td></tr>
 * </table>
 */
public final class McpPromptValidator extends AbstractValidator {

    /** A {@code {identifier}} placeholder. */
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{(\\w+)\\}");

    @Override
    public List<ValidationEvent> validate(Model model) {
        List<ValidationEvent> events = new ArrayList<>();

        for (ServiceShape service : model.getServiceShapes()) {
            ModelIndex index = new ModelIndex(model, service.getId());

            // Collect every prompt's effective name across the service to catch duplicates
            // (a service prompt and an op-default colliding both count).
            Set<String> seenNames = new HashSet<>();
            Set<String> reportedDup = new HashSet<>();

            // Service-level prompts: name required, no derivation.
            for (McpPromptsTrait.Prompt p : index.servicePrompts()) {
                String name = p.getName().map(String::trim).orElse("");
                if (name.isEmpty()) {
                    events.add(error(service,
                        "Service-level @mcpPrompts prompt has no `name` (Plan 14, §12.6). A "
                            + "service prompt has no operation to default from; `name` is required."));
                } else {
                    flagDuplicate(service, name, seenNames, reportedDup, events);
                }
                validatePromptBody(service, p, p.getArguments().stream()
                    .map(McpPromptsTrait.Argument::getName).toList(), name, events);
            }

            // Operation-anchored prompts: default name, derive args when omitted.
            for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
                List<McpPromptsTrait.Prompt> prompts = index.promptsFor(op);
                if (prompts.isEmpty()) continue;
                String opName = op.getId().getName();
                String defaultName = kebab(opName);
                for (McpPromptsTrait.Prompt p : prompts) {
                    String name = p.getName().map(String::trim)
                        .filter(n -> !n.isEmpty()).orElse(defaultName);
                    flagDuplicate(op, name, seenNames, reportedDup, events);

                    // The arg names the prompt may legally reference: declared args, or —
                    // when `arguments` is omitted — the derived input members.
                    List<String> argNames = p.isArgumentsDeclared()
                        ? p.getArguments().stream().map(McpPromptsTrait.Argument::getName).toList()
                        : index.derivePromptArguments(op).stream().map(a -> a.name).toList();
                    validatePromptBody(op, p, argNames, name, events);
                }
            }
        }

        return events;
    }

    /** Per-prompt checks shared by service- and operation-level prompts. */
    private void validatePromptBody(Shape shape, McpPromptsTrait.Prompt p,
                                    List<String> argNames, String effectiveName,
                                    List<ValidationEvent> events) {
        String template = p.getTemplate();

        // Empty / whitespace-only template (Smithy's @required passes a whitespace value).
        if (template == null || template.trim().isEmpty()) {
            events.add(error(shape,
                "@mcpPrompts prompt `" + effectiveName + "` has an empty `template` (Plan 14, "
                    + "§12.6). `template` is @required but a whitespace-only value is meaningless."));
        }

        // Argument-name collision within one prompt.
        Set<String> declared = new LinkedHashSet<>();
        for (String argName : argNames) {
            if (!declared.add(argName)) {
                events.add(error(shape,
                    "@mcpPrompts prompt `" + effectiveName + "` declares argument `" + argName
                        + "` more than once (Plan 14, §12.6). Argument names must be unique."));
            }
        }

        if (template == null) return;

        // Placeholder references an undeclared/underivable argument.
        Matcher m = PLACEHOLDER.matcher(template);
        while (m.find()) {
            String key = m.group(1);
            if (!declared.contains(key)) {
                events.add(error(shape,
                    "@mcpPrompts prompt `" + effectiveName + "` template references `{" + key
                        + "}` but no argument named `" + key + "` is declared or derivable "
                        + "(Plan 14, §12.6)."));
            }
        }

        // Unbalanced braces / non-identifier placeholder content — likely a typo. The
        // emitter treats these as literal text, so WARN rather than fail.
        if (hasBraceAnomaly(template)) {
            events.add(warning(shape,
                "@mcpPrompts prompt `" + effectiveName + "` template has unbalanced `{`/`}` or "
                    + "a placeholder with non-identifier characters (Plan 14, §12.6). It will be "
                    + "treated as literal text — likely an authoring typo."));
        }
    }

    private void flagDuplicate(Shape shape, String name, Set<String> seen,
                               Set<String> reported, List<ValidationEvent> events) {
        if (!seen.add(name) && reported.add(name)) {
            events.add(error(shape,
                "Duplicate @mcpPrompts prompt name `" + name + "` within the service (Plan 14, "
                    + "§12.6). Two prompts with the same effective name collide in prompts/list "
                    + "and prompts/get lookup."));
        }
    }

    /**
     * True when the template's braces are unbalanced or it contains a {@code {…}} run that
     * is NOT a clean identifier placeholder (e.g. {@code {a.b}}, {@code {a b}}, {@code {}}).
     */
    private boolean hasBraceAnomaly(String template) {
        int opens = 0;
        int closes = 0;
        for (int i = 0; i < template.length(); i++) {
            char c = template.charAt(i);
            if (c == '{') opens++;
            else if (c == '}') closes++;
        }
        if (opens != closes) return true;

        // Every `{…}` run must be a clean `\w+` placeholder.
        Matcher braces = Pattern.compile("\\{([^}]*)\\}").matcher(template);
        while (braces.find()) {
            String inner = braces.group(1);
            if (!inner.matches("\\w+")) return true;
        }
        return false;
    }

    /** Mirrors {@code McpManifestEmitter.kebab} for op-name → default prompt name. */
    private static String kebab(String name) {
        return name.replaceAll("([A-Z])", "-$1").toLowerCase().replaceFirst("^-", "");
    }
}
