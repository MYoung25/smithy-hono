package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.net.URL;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class AuthDeclarationValidatorTest {

    private static final String HEADER =
        "$version: \"2.0\"\n" +
        "namespace com.test\n" +
        "use com.smithyhono#requiresAuth\n";

    private ValidatedResult<Model> assemble(String ops) {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy", HEADER + ops)
                .assemble();
    }

    private static long authErrors(ValidatedResult<Model> result) {
        return result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.containsId("AuthDeclaration") || e.getMessage().contains("auth declaration"))
                .count();
    }

    @Test
    void undeclaredAuthOperationFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [Naked] }\n" +
            "@http(method: \"GET\", uri: \"/naked\", code: 200)\n" +
            "operation Naked {}\n");

        List<ValidationEvent> errors = result.getValidationEvents(Severity.ERROR);
        assertTrue(authErrors(result) >= 1,
            "Expected an AUTH-02 error for the undeclared-auth op. Events: " + errors);
        assertTrue(errors.stream().anyMatch(e -> e.getMessage().contains("Naked")),
            "Error should reference the offending op. Events: " + errors);
    }

    @Test
    void requiresAuthOperationPasses() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [Secure] }\n" +
            "@http(method: \"GET\", uri: \"/secure\", code: 200)\n" +
            "@requiresAuth(permission: \"x.read\")\n" +
            "operation Secure {}\n");
        assertEquals(0, authErrors(result),
            "requiresAuth op should pass. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void optionalAuthOperationPasses() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [Public] }\n" +
            "@http(method: \"GET\", uri: \"/public\", code: 200)\n" +
            "@optionalAuth\n" +
            "operation Public {}\n");
        assertEquals(0, authErrors(result),
            "optionalAuth op should pass. Events: " + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void nonHttpOperationIsIgnored() {
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\", operations: [Internal] }\n" +
            "operation Internal {}\n");
        assertEquals(0, authErrors(result),
            "non-HTTP op should not trigger AUTH-02. Events: " + result.getValidationEvents(Severity.ERROR));
    }
}
