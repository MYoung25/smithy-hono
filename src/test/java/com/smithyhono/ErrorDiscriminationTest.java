package com.smithyhono;

import com.smithyhono.writers.RouteEmitter;
import com.smithyhono.writers.TypeScriptFileWriter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ErrorDiscriminationTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model modelFor(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    private static String emitErrors(Model m, String... shapeNames) {
        RouteEmitter emitter = new RouteEmitter(m, null);
        TypeScriptFileWriter writer = new TypeScriptFileWriter();
        List<StructureShape> errors = new java.util.ArrayList<>();
        for (String name : shapeNames) {
            errors.add(m.expectShape(ShapeId.from("test#" + name), StructureShape.class));
        }
        emitter.emitErrorClasses(errors, writer);
        return writer.getContent();
    }

    @Test
    void clientErrorWithHttpErrorGetsCorrectStatusCode() {
        Model m = modelFor(
                "@error(\"client\") @httpError(404)\n" +
                "structure NotFoundError { message: String }");
        String out = emitErrors(m, "NotFoundError");
        assertTrue(out.contains("readonly $statusCode = 404"), "Expected 404: " + out);
        assertTrue(out.contains("readonly $fault = 'client' as const"), "Expected client fault: " + out);
    }

    @Test
    void serverErrorWithHttpErrorGetsCorrectStatusCode() {
        Model m = modelFor(
                "@error(\"server\") @httpError(503)\n" +
                "structure ServiceUnavailableError { message: String }");
        String out = emitErrors(m, "ServiceUnavailableError");
        assertTrue(out.contains("readonly $statusCode = 503"), "Expected 503: " + out);
        assertTrue(out.contains("readonly $fault = 'server' as const"), "Expected server fault: " + out);
    }

    @Test
    void clientErrorWithoutHttpErrorDefaultsTo400() {
        Model m = modelFor(
                "@error(\"client\")\n" +
                "structure BadRequestError { message: String }");
        String out = emitErrors(m, "BadRequestError");
        assertTrue(out.contains("readonly $statusCode = 400"), "Expected 400 default: " + out);
        assertTrue(out.contains("readonly $fault = 'client' as const"));
    }

    @Test
    void serverErrorWithoutHttpErrorDefaultsTo500() {
        Model m = modelFor(
                "@error(\"server\")\n" +
                "structure InternalError { message: String }");
        String out = emitErrors(m, "InternalError");
        assertTrue(out.contains("readonly $statusCode = 500"), "Expected 500 default: " + out);
        assertTrue(out.contains("readonly $fault = 'server' as const"));
    }

    @Test
    void errorClassExtendsError() {
        Model m = modelFor(
                "@error(\"client\") @httpError(400)\n" +
                "structure ValidationException { message: String }");
        String out = emitErrors(m, "ValidationException");
        assertTrue(out.contains("export class ValidationException extends Error {"),
                "Should extend Error: " + out);
    }

    @Test
    void errorClassSetsPrototype() {
        Model m = modelFor(
                "@error(\"client\") @httpError(400)\n" +
                "structure MyError { message: String }");
        String out = emitErrors(m, "MyError");
        assertTrue(out.contains("Object.setPrototypeOf(this, MyError.prototype)"),
                "Should set prototype: " + out);
        assertTrue(out.contains("this.name = 'MyError'"), "Should set name: " + out);
    }

    @Test
    void throttlingRetryableErrorGetsRetryableAndThrottlingMarkers() {
        // RATE-02 — a @retryable(throttling: true) error (e.g. ThrottlingException)
        // carries both retry hints so generated clients back off correctly.
        Model m = modelFor(
                "@error(\"client\") @httpError(429) @retryable(throttling: true)\n" +
                "structure ThrottlingException { message: String }");
        String out = emitErrors(m, "ThrottlingException");
        assertTrue(out.contains("readonly $statusCode = 429"), "Expected 429: " + out);
        assertTrue(out.contains("readonly $retryable = true as const"), "Expected retryable: " + out);
        assertTrue(out.contains("readonly $throttling = true as const"), "Expected throttling: " + out);
    }

    @Test
    void plainRetryableErrorGetsRetryableButNotThrottling() {
        Model m = modelFor(
                "@error(\"server\") @httpError(503) @retryable\n" +
                "structure ServiceUnavailableError { message: String }");
        String out = emitErrors(m, "ServiceUnavailableError");
        assertTrue(out.contains("readonly $retryable = true as const"), "Expected retryable: " + out);
        assertFalse(out.contains("$throttling"), "Non-throttling retryable must not emit $throttling: " + out);
    }

    @Test
    void nonRetryableErrorHasNoRetryMarkers() {
        Model m = modelFor(
                "@error(\"client\") @httpError(404)\n" +
                "structure NotFoundError { message: String }");
        String out = emitErrors(m, "NotFoundError");
        assertFalse(out.contains("$retryable"), "Non-retryable error must not emit $retryable: " + out);
        assertFalse(out.contains("$throttling"), "Non-retryable error must not emit $throttling: " + out);
    }

    @Test
    void multipleErrorsAreAllEmitted() {
        Model m = modelFor(
                "@error(\"client\") @httpError(404)\n" +
                "structure NotFoundError { message: String }\n" +
                "@error(\"client\") @httpError(400)\n" +
                "structure ValidationError { message: String }");
        String out = emitErrors(m, "NotFoundError", "ValidationError");
        assertTrue(out.contains("class NotFoundError"), "Should contain NotFoundError: " + out);
        assertTrue(out.contains("class ValidationError"), "Should contain ValidationError: " + out);
    }
}
