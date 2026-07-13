package com.smithyhono;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.validation.Severity;
import software.amazon.smithy.model.validation.ValidatedResult;

import static org.junit.jupiter.api.Assertions.*;

class OperationCollisionValidatorTest {

    private static long collisionErrors(ValidatedResult<Model> result) {
        return result.getValidationEvents(Severity.ERROR).stream()
                .filter(e -> e.getMessage().contains("CG-08"))
                .count();
    }

    @Test
    void sameSimpleNameInDifferentNamespacesFailsBuild() {
        // Two `GetThing` ops in different namespaces, distinct paths (so only the
        // simple-name collision fires). The registry keys OPERATIONS by simple name,
        // so without this guard the second silently overwrites the first.
        ValidatedResult<Model> result = Model.assembler()
                .addUnparsedModel("a.smithy",
                    "$version: \"2.0\"\nnamespace com.a\n" +
                    "@http(method: \"GET\", uri: \"/a\", code: 200)\n@optionalAuth\noperation GetThing {}\n")
                .addUnparsedModel("b.smithy",
                    "$version: \"2.0\"\nnamespace com.b\n" +
                    "@http(method: \"GET\", uri: \"/b\", code: 200)\n@optionalAuth\noperation GetThing {}\n")
                .addUnparsedModel("svc.smithy",
                    "$version: \"2.0\"\nnamespace com.svc\n" +
                    "service S { version: \"1.0\", operations: [com.a#GetThing, com.b#GetThing] }\n")
                .assemble();

        assertEquals(1, collisionErrors(result),
            "Expected one CG-08 simple-name collision. Events: "
                + result.getValidationEvents(Severity.ERROR));
        assertTrue(result.getValidationEvents(Severity.ERROR).stream()
                .anyMatch(e -> e.getMessage().contains("GetThing")),
            "Error should name the colliding simple name.");
    }

    @Test
    void sameMethodAndRouteFailsBuild() {
        // Distinct simple names but the same method+route after label-name
        // normalization (/thing/{id} vs /thing/{name}) — a Hono routing collision
        // Smithy's literal HttpUriConflict does not catch.
        ValidatedResult<Model> result = Model.assembler()
                .addUnparsedModel("test.smithy",
                    "$version: \"2.0\"\nnamespace com.test\n" +
                    "service S { version: \"1.0\", operations: [GetById, GetByName] }\n" +
                    "@http(method: \"GET\", uri: \"/thing/{id}\", code: 200)\n@optionalAuth\n" +
                    "operation GetById { input: ById }\n" +
                    "@http(method: \"GET\", uri: \"/thing/{name}\", code: 200)\n@optionalAuth\n" +
                    "operation GetByName { input: ByName }\n" +
                    "structure ById { @httpLabel @required id: String }\n" +
                    "structure ByName { @httpLabel @required name: String }\n")
                .assemble();

        assertEquals(1, collisionErrors(result),
            "Expected one CG-08 route collision. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }

    @Test
    void distinctOperationsPass() {
        ValidatedResult<Model> result = Model.assembler()
                .addUnparsedModel("test.smithy",
                    "$version: \"2.0\"\nnamespace com.test\n" +
                    "service S { version: \"1.0\", operations: [ListThings, GetThing] }\n" +
                    "@http(method: \"GET\", uri: \"/things\", code: 200)\n@optionalAuth\noperation ListThings {}\n" +
                    "@http(method: \"GET\", uri: \"/things/{id}\", code: 200)\n@optionalAuth\n" +
                    "operation GetThing { input: GetThingInput }\n" +
                    "structure GetThingInput { @httpLabel @required id: String }\n")
                .assemble();

        assertEquals(0, collisionErrors(result),
            "Distinct operations should not collide. Events: "
                + result.getValidationEvents(Severity.ERROR));
    }
}
