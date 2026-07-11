package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;

import java.net.URL;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Plan 14 (§12.6): McpPromptValidator negatives. Each case asserts the relevant ERROR
 * (or WARNING) is raised; a final positive case guards against false positives.
 */
class McpPromptValidatorTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#mcpPrompts\n";

    private ValidatedResult<Model> assemble(String body) {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", HEADER + body)
                .assemble();
    }

    private static boolean hasError(ValidatedResult<Model> r, String needle) {
        return r.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains(needle));
    }

    private static boolean hasWarning(ValidatedResult<Model> r, String needle) {
        return r.getValidationEvents(Severity.WARNING).stream()
                .anyMatch(e -> e.getMessage().contains(needle));
    }

    /** A minimal CreateNote op + IO shapes, reused across cases. */
    private static String createNoteOp(String promptsTrait) {
        return promptsTrait +
            "@http(method: \"POST\", uri: \"/notes\", code: 201)\n@optionalAuth\n" +
            "operation CreateNote { input: CreateNoteInput, output: CreateNoteOutput }\n" +
            "structure CreateNoteInput { @required @httpPayload body: String }\n" +
            "structure CreateNoteOutput { @required id: String }\n";
    }

    @Test
    void serviceLevelPromptMissingNameFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ description: \"no name\", template: \"hello\" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp(""));
        assertTrue(hasError(result, "no `name`"),
            "service prompt without name should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void duplicatePromptNamesFailBuild() {
        // A service prompt named `create-note` collides with the OP-DEFAULT name of CreateNote.
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ name: \"create-note\", template: \"x\" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp("@mcpPrompts([{ template: \"y\" }])\n"));
        assertTrue(hasError(result, "Duplicate @mcpPrompts prompt name `create-note`"),
            "service name colliding with op default should fail. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void undeclaredPlaceholderFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp("@mcpPrompts([{ name: \"p\", arguments: [{ name: \"a\" }], "
                + "template: \"refs {missing}\" }])\n"));
        assertTrue(hasError(result, "{missing}"),
            "undeclared placeholder should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void derivedPlaceholderPassesForOmittedArgs() {
        // `arguments` omitted on the op prompt → `{body}` is a derivable input member, no error.
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp("@mcpPrompts([{ template: \"from {body}\" }])\n"));
        assertEquals(0, result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.getMessage().contains("Plan 14")).count(),
            "derivable placeholder must pass. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void duplicateArgumentNamesFailBuild() {
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ name: \"p\", arguments: [{ name: \"a\" }, { name: \"a\" }], "
                + "template: \"hi\" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp(""));
        assertTrue(hasError(result, "more than once"),
            "duplicate arg names should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void emptyTemplateFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ name: \"p\", template: \"   \" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp(""));
        assertTrue(hasError(result, "empty `template`"),
            "whitespace-only template should fail. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void unbalancedBracesWarn() {
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ name: \"p\", template: \"a {b\" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp(""));
        assertTrue(hasWarning(result, "unbalanced"),
            "unbalanced braces should warn. Events: " + result.getValidationEvents(Severity.WARNING));
    }

    @Test
    void validPromptsProduceNoErrors() {
        ValidatedResult<Model> result = assemble(
            "@mcpPrompts([{ name: \"triage\", arguments: [{ name: \"focus\" }], "
                + "template: \"focus on {focus}\" }])\n" +
            "service S { version: \"1.0\", operations: [CreateNote] }\n" +
            createNoteOp("@mcpPrompts([{ template: \"from {body}\" }])\n"));
        assertEquals(0, result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.getMessage().contains("Plan 14")).count(),
            "valid prompts must produce no errors. Events: " + result.getValidationEvents(Severity.ERROR));
        assertEquals(0, result.getValidationEvents(Severity.WARNING).stream()
                .filter(e -> e.getMessage().contains("Plan 14")).count(),
            "valid prompts must produce no warnings. Events: " + result.getValidationEvents(Severity.WARNING));
    }
}
