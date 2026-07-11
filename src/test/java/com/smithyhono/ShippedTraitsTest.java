package com.smithyhono;

import com.smithyhono.traits.SseStreamTrait;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ShapeId;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Fix 1 — the SHIPPED trait file ({@code model/traits.smithy}, the one consumers
 * {@code use}) must define every supported trait, including {@code @sseStream}. The Java
 * {@link SseStreamTrait} + its TraitService provider already exist; without the smithy shape
 * definition a downstream model that does {@code use com.smithyhono#sseStream} can't resolve it.
 */
class ShippedTraitsTest {

    private Path shippedTraits() {
        // user.dir is the project root during test execution.
        Path p = Path.of(System.getProperty("user.dir"), "model", "traits.smithy");
        assertTrue(Files.exists(p), "shipped model/traits.smithy not found: " + p);
        return p;
    }

    @Test
    void shippedTraitsFileDefinesSseStream() throws Exception {
        String src = Files.readString(shippedTraits());
        assertTrue(src.contains("structure sseStream {}"),
                "model/traits.smithy must define @trait structure sseStream {}\n" + src);
    }

    @Test
    void consumerCanUseSseStreamFromShippedTraits() throws Exception {
        // A consumer model that `use`s the shipped trait and applies @sseStream must assemble
        // cleanly and the trait must resolve to the Java SseStreamTrait shape id.
        Model model = Model.assembler()
                .addImport(shippedTraits().toUri().toURL())
                .addUnparsedModel("consumer.smithy",
                        "$version: \"2.0\"\n" +
                        "namespace com.consumer\n" +
                        "use com.smithyhono#sseStream\n" +
                        "@sseStream\n" +
                        "@http(method: \"GET\", uri: \"/events\", code: 200)\n" +
                        "@readonly\n" +
                        "operation StreamEvents { output: StreamEventsOutput }\n" +
                        "structure StreamEventsOutput { ok: Boolean }\n")
                .assemble()
                .unwrap();

        OperationShape op = model.expectShape(
                ShapeId.from("com.consumer#StreamEvents"), OperationShape.class);
        assertTrue(op.hasTrait(SseStreamTrait.class),
                "the @sseStream trait must resolve from the shipped model/traits.smithy");
        assertEquals(SseStreamTrait.ID, ShapeId.from("com.smithyhono#sseStream"));
    }
}
