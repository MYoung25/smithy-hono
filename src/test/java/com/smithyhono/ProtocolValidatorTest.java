package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;
import software.amazon.smithy.model.validation.ValidationEvent;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ProtocolValidatorTest {

    /** A throwaway protocol trait so a service can declare a non-restJson1 protocol. */
    private static final String FAKE_PROTOCOL =
        "$version: \"2.0\"\n" +
        "namespace com.fake\n" +
        "@protocolDefinition\n" +
        "@trait(selector: \"service\")\n" +
        "structure fakeProtocol {}\n";

    /** A stand-in for aws.protocols#restJson1 (same shape id), so we can declare it. */
    private static final String REST_JSON_1 =
        "$version: \"2.0\"\n" +
        "namespace aws.protocols\n" +
        "@protocolDefinition\n" +
        "@trait(selector: \"service\")\n" +
        "structure restJson1 {}\n";

    private ValidatedResult<Model> assemble(String service) {
        return Model.assembler()
                .addUnparsedModel("fake-protocol.smithy", FAKE_PROTOCOL)
                .addUnparsedModel("rest-json.smithy", REST_JSON_1)
                .addUnparsedModel("test.smithy",
                    "$version: \"2.0\"\n" +
                    "namespace com.test\n" +
                    "use com.fake#fakeProtocol\n" +
                    "use aws.protocols#restJson1\n" +
                    service)
                .assemble();
    }

    private static long protocolErrors(ValidatedResult<Model> result) {
        return result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.getMessage().contains("CG-07"))
                .count();
    }

    @Test
    void nonRestJson1ProtocolFailsBuild() {
        ValidatedResult<Model> result = assemble(
            "@fakeProtocol\n" +
            "service S { version: \"1.0\" }\n");

        assertEquals(1, protocolErrors(result),
            "Expected a CG-07 error for the non-restJson1 protocol. Events: "
                + result.getValidationEvents(Severity.ERROR));
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("fakeProtocol")),
            "Error should name the unsupported protocol.");
    }

    @Test
    void noProtocolTraitIsAllowed() {
        // The documented assumed default: a trait-less service is restJson1.
        ValidatedResult<Model> result = assemble(
            "service S { version: \"1.0\" }\n");
        assertEquals(0, protocolErrors(result));
    }

    @Test
    void explicitRestJson1IsAllowed() {
        ValidatedResult<Model> result = assemble(
            "@restJson1\n" +
            "service S { version: \"1.0\" }\n");
        assertEquals(0, protocolErrors(result));
    }
}
