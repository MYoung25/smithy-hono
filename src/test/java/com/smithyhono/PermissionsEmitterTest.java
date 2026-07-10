package com.smithyhono;

import com.smithyhono.traits.RequiresAuthTrait;
import com.smithyhono.writers.PermissionsEmitter;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.model.pattern.UriPattern;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.traits.HttpTrait;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PermissionsEmitterTest {

    @Test
    void toConstantName_convertsDotsToUnderscores() {
        assertEquals("TODOS_READ", PermissionsEmitter.toConstantName("todos.read"));
        assertEquals("TODOS_WRITE", PermissionsEmitter.toConstantName("todos.write"));
    }

    @Test
    void toConstantName_convertsHyphensToUnderscores() {
        assertEquals("MY_PERMISSION", PermissionsEmitter.toConstantName("my-permission"));
    }

    @Test
    void toConstantName_collapseMultipleSeparators() {
        assertEquals("FOO_BAR", PermissionsEmitter.toConstantName("foo..bar"));
    }

    @Test
    void emit_returnsFalseForEmptyGroups() throws Exception {
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        assertFalse(new PermissionsEmitter().emit(List.of(List.of()), manifest));
    }

    @Test
    void emit_returnsFalseWhenNoRequiresAuth() throws Exception {
        OperationShape op = OperationShape.builder()
                .id("test#PublicOp")
                .addTrait(HttpTrait.builder()
                        .method("GET")
                        .uri(UriPattern.parse("/public"))
                        .code(200)
                        .build())
                .build();
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        assertFalse(new PermissionsEmitter().emit(List.of(List.of(op)), manifest));
        assertFalse(Files.exists(tmpDir.resolve("permissions.gen.ts")));
    }

    @Test
    void emit_returnsTrueAndWritesFile() throws Exception {
        OperationShape op = authedOp("test#SecureOp", "/items", "items.read");
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        assertTrue(new PermissionsEmitter().emit(List.of(List.of(op)), manifest));
        assertTrue(Files.exists(tmpDir.resolve("permissions.gen.ts")));
    }

    @Test
    void emit_outputContainsPermissionsObjectAndType() throws Exception {
        OperationShape op = authedOp("test#SecureOp", "/items", "todos.read");
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        new PermissionsEmitter().emit(List.of(List.of(op)), manifest);
        String content = Files.readString(tmpDir.resolve("permissions.gen.ts"));
        assertTrue(content.contains("export const Permissions = {"), "Permissions object: " + content);
        assertTrue(content.contains("TODOS_READ: \"todos.read\""), "Constant entry: " + content);
        assertTrue(content.contains("export type Permission = typeof Permissions[keyof typeof Permissions]"),
                "Permission type: " + content);
    }

    @Test
    void emit_deduplicatesPermissions() throws Exception {
        OperationShape op1 = authedOp("test#Op1", "/items", "items.write");
        OperationShape op2 = authedOp("test#Op2", "/items/{id}", "items.write");
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        new PermissionsEmitter().emit(List.of(List.of(op1, op2)), manifest);
        String content = Files.readString(tmpDir.resolve("permissions.gen.ts"));
        int count = content.split("ITEMS_WRITE", -1).length - 1;
        assertEquals(1, count, "ITEMS_WRITE should appear exactly once: " + content);
    }

    @Test
    void emit_collectsPermissionsAcrossGroups() throws Exception {
        OperationShape op1 = authedOp("test#Op1", "/a", "a.read");
        OperationShape op2 = authedOp("test#Op2", "/b", "b.write");
        Path tmpDir = Files.createTempDirectory("perm-test");
        FileManifest manifest = FileManifest.create(tmpDir);
        new PermissionsEmitter().emit(List.of(List.of(op1), List.of(op2)), manifest);
        String content = Files.readString(tmpDir.resolve("permissions.gen.ts"));
        assertTrue(content.contains("A_READ: \"a.read\""), "a.read constant: " + content);
        assertTrue(content.contains("B_WRITE: \"b.write\""), "b.write constant: " + content);
    }

    private static OperationShape authedOp(String id, String uri, String permission) {
        return OperationShape.builder()
                .id(id)
                .addTrait(RequiresAuthTrait.builder().permission(permission).build())
                .addTrait(HttpTrait.builder()
                        .method("GET")
                        .uri(UriPattern.parse(uri))
                        .code(200)
                        .build())
                .build();
    }
}
