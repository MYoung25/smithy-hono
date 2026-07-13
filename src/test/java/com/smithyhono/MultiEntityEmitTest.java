package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * End-to-end emit tests for the multi-resource codegen defects (fix/codegen-multi-entity-emit):
 * cross-referenced entity Data types hoisted to shared.gen.ts (Fix 2), service-level error
 * classes hoisted to errors.gen.ts + FetchLike to client-runtime.gen.ts so the barrel doesn't
 * double-export (Fix 3), and declared @persisted index keys wired into the list filter (Fix 4).
 *
 * <p>The fixture model {@code multi-entity.smithy} has two @persisted resources (User,
 * Playthrough) whose entity types cross-reference each other and whose ops share service-level
 * NotFoundError + ValidationException; Playthrough declares a byGame index with a matching
 * gameId list @httpQuery.
 */
class MultiEntityEmitTest {

    private Path generate() throws Exception {
        URL traitsUrl = getClass().getResource("/traits.smithy");
        assertNotNull(traitsUrl, "traits.smithy missing from test resources");
        URL modelUrl = getClass().getResource("/models/multi-entity.smithy");
        assertNotNull(modelUrl, "multi-entity.smithy fixture not found");

        Model model = Model.assembler()
                .addImport(traitsUrl)
                .addImport(modelUrl)
                .assemble()
                .unwrap();

        Path out = Files.createTempDirectory("multi-entity-emit");
        PluginContext context = PluginContext.builder()
                .model(model)
                .fileManifest(FileManifest.create(out))
                .settings(Node.objectNodeBuilder()
                        .withMember("service", "com.test#MultiEntityService")
                        .build())
                .build();
        new HonoCodegenPlugin().execute(context);
        return out;
    }

    private String read(Path dir, String name) throws Exception {
        Path p = dir.resolve(name);
        assertTrue(Files.exists(p), "expected generated file missing: " + name);
        return Files.readString(p);
    }

    // ── Fix 2 — hoisted entity Data type imported from its actual module ─────────

    @Test
    void crudImportsHoistedEntityFromSharedModule() throws Exception {
        Path dir = generate();

        // UserData + PlaythroughData are cross-referenced by both groups → shared.gen.ts.
        String shared = read(dir, "shared.gen.ts");
        assertTrue(shared.contains("export type UserData"), shared);
        assertTrue(shared.contains("export type PlaythroughData"), shared);

        // The crud file must import the entity type from ./shared.gen (where it actually lives),
        // not from the sibling router ./<stem>.gen which only re-imports it.
        String userCrud = read(dir, "user.crud.gen.ts");
        assertTrue(userCrud.contains("import type { UserData } from './shared.gen'"), userCrud);
        assertFalse(userCrud.contains("import type { UserData } from './user.gen'"), userCrud);
        assertFalse(userCrud.contains("import type { UserData, UserOperations } from './user.gen'"), userCrud);
        // The operations interface still comes from the router module.
        assertTrue(userCrud.contains("import type { UserOperations } from './user.gen'"), userCrud);

        String pCrud = read(dir, "playthrough.crud.gen.ts");
        assertTrue(pCrud.contains("import type { PlaythroughData } from './shared.gen'"), pCrud);
        assertFalse(pCrud.contains("import type { PlaythroughData } from './playthrough.gen'"), pCrud);
        assertTrue(pCrud.contains("import type { PlaythroughOperations } from './playthrough.gen'"), pCrud);
    }

    // ── Fix 3 — shared error classes + FetchLike emitted once, no barrel collision ─

    @Test
    void sharedErrorsHoistedToErrorsGenAndImportedNotRedeclared() throws Exception {
        Path dir = generate();

        // Service-level errors live in errors.gen.ts, declared once.
        String errors = read(dir, "errors.gen.ts");
        assertTrue(errors.contains("export class NotFoundError extends Error"), errors);
        assertTrue(errors.contains("export class ValidationException extends Error"), errors);

        // Resource modules import them, never re-declare them.
        String userGen = read(dir, "user.gen.ts");
        assertTrue(userGen.contains("import { NotFoundError, ValidationException } from './errors.gen'")
                   || userGen.contains("import { ValidationException, NotFoundError } from './errors.gen'"),
                   userGen);
        assertFalse(userGen.contains("export class NotFoundError"), userGen);
        assertFalse(userGen.contains("export class ValidationException"), userGen);

        String pGen = read(dir, "playthrough.gen.ts");
        assertFalse(pGen.contains("export class NotFoundError"), pGen);
        assertFalse(pGen.contains("export class ValidationException"), pGen);
    }

    @Test
    void crudImportsSharedErrorClassFromErrorsGen() throws Exception {
        Path dir = generate();
        // The factory throws NotFoundError on read/update/delete miss — it must import the shared
        // class from ./errors.gen, not the router module that no longer declares it.
        String userCrud = read(dir, "user.crud.gen.ts");
        assertTrue(userCrud.contains("import { NotFoundError } from './errors.gen'"), userCrud);
        assertFalse(userCrud.contains("import { NotFoundError } from './user.gen'"), userCrud);
        assertTrue(userCrud.contains("throw new NotFoundError("), userCrud);
    }

    @Test
    void fetchLikeEmittedOnceAndClientsImportIt() throws Exception {
        Path dir = generate();

        // Single FetchLike definition.
        String runtime = read(dir, "client-runtime.gen.ts");
        assertTrue(runtime.contains("export interface FetchLike"), runtime);

        // Each client imports it; none re-declares it.
        for (String stem : new String[] {"user", "playthrough"}) {
            String client = read(dir, stem + ".client.gen.ts");
            assertTrue(client.contains("import type { FetchLike } from './client-runtime.gen'"), client);
            assertFalse(client.contains("export interface FetchLike"), client);
        }
    }

    @Test
    void barrelDoesNotDoubleExportAnySymbol() throws Exception {
        Path dir = generate();
        String index = read(dir, "index.ts");
        // Each shared module is re-exported exactly once via export *.
        assertTrue(index.contains("export * from './errors.gen'"), index);
        assertTrue(index.contains("export * from './client-runtime.gen'"), index);
        assertTrue(index.contains("export * from './shared.gen'"), index);

        long errorsGen = index.lines().filter(l -> l.contains("from './errors.gen'")).count();
        assertEquals(1, errorsGen, "errors.gen exported more than once:\n" + index);
        long runtime = index.lines().filter(l -> l.contains("from './client-runtime.gen'")).count();
        assertEquals(1, runtime, "client-runtime.gen exported more than once:\n" + index);
    }

    // ── Fix 4 — declared index + matching list query param wired into filter ─────

    @Test
    void listFilterWiresDeclaredIndexQueryParam() throws Exception {
        Path dir = generate();
        String pCrud = read(dir, "playthrough.crud.gen.ts");

        // Playthrough declares index key gameId with a matching @httpQuery("gameId") on the list
        // op → the handler builds an equality filter and threads it to store.list.
        assertTrue(pCrud.contains("const filter: Record<string, string | number | boolean> = {}"), pCrud);
        assertTrue(pCrud.contains("if (input.gameId !== undefined) filter.gameId = input.gameId"), pCrud);
        assertTrue(pCrud.contains("limit: Math.min(input.maxResults ?? 25, 100), filter }"), pCrud);
    }

    @Test
    void listWithoutIndexKeepsUnfilteredBehavior() throws Exception {
        Path dir = generate();
        // User declares NO @persisted index → its list handler must stay unfiltered. (The
        // `filterList` hook is unrelated and may still appear; only the store.list filter must
        // be absent.)
        String userCrud = read(dir, "user.crud.gen.ts");
        assertFalse(userCrud.contains("const filter: Record"), userCrud);
        assertFalse(userCrud.contains(", filter }"), userCrud);
        assertTrue(userCrud.contains("limit: Math.min(input.maxResults ?? 25, 100) }"), userCrud);
    }
}
