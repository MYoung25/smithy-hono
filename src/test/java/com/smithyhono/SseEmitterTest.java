package com.smithyhono;

import com.smithyhono.writers.SseEmitter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class SseEmitterTest {

    private static final String NS = "$version: \"2.0\"\nnamespace test\n";

    private static Model plainModel(String smithy) {
        return Model.assembler()
                .addUnparsedModel("test.smithy", NS + smithy)
                .assemble()
                .unwrap();
    }

    private static Model withTraits(String smithy) {
        URL traitsUrl = SseEmitterTest.class.getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy not found in test resources");
        return Model.assembler()
                .addImport(traitsUrl)
                .addUnparsedModel("test.smithy",
                        NS + "use com.smithyhono#sseEvent\n" + smithy)
                .assemble()
                .unwrap();
    }

    private static ServiceShape serviceShape(String id) {
        return ServiceShape.builder().id(id).version("1.0").build();
    }

    // ── hasEvents ──────────────────────────────────────────────────────────────

    @Test
    void hasEventsReturnsFalseWhenNoSseEventShapes() {
        Model m = plainModel("structure Foo { @required id: String }");
        ServiceShape svc = serviceShape("test#TestService");
        assertFalse(new SseEmitter(m, svc).hasEvents());
    }

    @Test
    void hasEventsReturnsTrueWhenSseEventPresent(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"thing:done\")\n" +
                "structure ThingDoneEvent { @required id: String }");
        ServiceShape svc = serviceShape("test#TestService");
        assertTrue(new SseEmitter(m, svc).hasEvents());
    }

    // ── emit() ─────────────────────────────────────────────────────────────────

    @Test
    void noSseEventsProducesNoEventsFile(@TempDir Path tmp) throws Exception {
        Model m = plainModel("structure Foo { id: String }");
        ServiceShape svc = serviceShape("test#TestService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);
        assertFalse(Files.exists(tmp.resolve("events.gen.ts")),
                "No events.gen.ts should be produced when there are no @sseEvent shapes");
    }

    @Test
    void emitsDiscriminatedUnion(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"game:started\")\n" +
                "structure GameStartedEvent { @required gameId: String }\n" +
                "@sseEvent(eventType: \"game:ended\")\n" +
                "structure GameEndedEvent { @required gameId: String }");
        ServiceShape svc = serviceShape("test#GameService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        assertTrue(content.contains("export type GameEvent ="), "Union type declaration: " + content);
        assertTrue(content.contains("| { type: \"game:started\"; data: GameStartedEvent }"),
                "game:started variant: " + content);
        assertTrue(content.contains("| { type: \"game:ended\"; data: GameEndedEvent }"),
                "game:ended variant: " + content);
    }

    @Test
    void emitsEmitterInterface(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"msg\")\n" +
                "structure MessageEvent { @required text: String }");
        ServiceShape svc = serviceShape("test#ChatService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        assertTrue(content.contains("export interface ChatEventEmitter {"), "Emitter interface: " + content);
        assertTrue(content.contains("emit(channelId: string, event: ChatEvent): Promise<void>"),
                "emit() method: " + content);
    }

    @Test
    void emitsEventSourceClass(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"update\")\n" +
                "structure UpdateEvent { @required data: String }");
        ServiceShape svc = serviceShape("test#FeedService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        assertTrue(content.contains("export class FeedEventSource {"), "EventSource class: " + content);
        assertTrue(content.contains("on<T extends FeedEvent['type']>("), "on() method: " + content);
        assertTrue(content.contains("close(): void"), "close() method: " + content);
    }

    @Test
    void unionTypeUsesServiceNameAsPrefix(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"ping\")\n" +
                "structure PingEvent { @required ts: Integer }");
        ServiceShape svc = serviceShape("test#MonitorService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        assertTrue(content.contains("export type MonitorEvent ="),
                "Prefix derived from service name: " + content);
        assertTrue(content.contains("export interface MonitorEventEmitter {"),
                "Emitter uses service prefix: " + content);
        assertTrue(content.contains("export class MonitorEventSource {"),
                "EventSource uses service prefix: " + content);
    }

    @Test
    void emitsZodSchemasForEventShapes(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"tick\")\n" +
                "structure TickEvent { @required count: Integer\nactive: Boolean }");
        ServiceShape svc = serviceShape("test#ClockService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        assertTrue(content.contains("export const TickEventSchema"), "Zod schema: " + content);
        assertTrue(content.contains("export type TickEvent"), "TypeScript type: " + content);
    }

    @Test
    void emitsEventsInSortedOrder(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"z:last\")\n" +
                "structure ZLastEvent { @required id: String }\n" +
                "@sseEvent(eventType: \"a:first\")\n" +
                "structure AFirstEvent { @required id: String }");
        ServiceShape svc = serviceShape("test#TestService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);

        String content = Files.readString(tmp.resolve("events.gen.ts"));
        int aPos = content.indexOf("AFirstEvent");
        int zPos = content.indexOf("ZLastEvent");
        assertTrue(aPos < zPos, "Schemas should be sorted alphabetically: " + content);
    }

    @Test
    void emitsTemplateFile(@TempDir Path tmp) throws Exception {
        Model m = withTraits(
                "@sseEvent(eventType: \"event\")\n" +
                "structure SomeEvent { @required id: String }");
        ServiceShape svc = serviceShape("test#TestService");
        FileManifest manifest = FileManifest.create(tmp);
        new SseEmitter(m, svc).emit(manifest);
        assertTrue(Files.exists(tmp.resolve("events.template.ts")),
                "events.template.ts should be produced");
    }
}
