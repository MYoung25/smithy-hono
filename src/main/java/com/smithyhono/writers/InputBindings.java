package com.smithyhono.writers;

import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.*;

import java.util.LinkedHashMap;
import java.util.Map;

public class InputBindings {
    public final Map<String, MemberShape> pathMembers   = new LinkedHashMap<>();
    public final Map<String, MemberShape> queryMembers  = new LinkedHashMap<>();
    public final Map<String, MemberShape> headerMembers = new LinkedHashMap<>();
    public final Map<String, MemberShape> bodyMembers   = new LinkedHashMap<>();
    // CG-05 — catch-all map bindings (each is its own member, assembled from the
    // leftover query params / prefix-matched headers rather than a single field).
    public final Map<String, MemberShape> queryParamsMembers   = new LinkedHashMap<>();
    public final Map<String, MemberShape> prefixHeadersMembers = new LinkedHashMap<>();
    public String payloadMemberName = null;

    public InputBindings(StructureShape input, String httpMethod) {
        boolean hasBody = isBodyMethod(httpMethod);
        for (Map.Entry<String, MemberShape> entry : input.getAllMembers().entrySet()) {
            String name = entry.getKey();
            MemberShape member = entry.getValue();
            switch (resolveBinding(member, hasBody)) {
                case PATH           -> pathMembers.put(name, member);
                case QUERY,
                 IMPLICIT_QUERY     -> queryMembers.put(name, member);
                case HEADER         -> headerMembers.put(name, member);
                case PAYLOAD        -> { payloadMemberName = name; bodyMembers.put(name, member); }
                case IMPLICIT_BODY  -> bodyMembers.put(name, member);
                case QUERY_PARAMS   -> queryParamsMembers.put(name, member);
                case PREFIX_HEADERS -> prefixHeadersMembers.put(name, member);
            }
        }
    }

    public boolean hasPayload() {
        return payloadMemberName != null;
    }

    public static HttpBinding resolveBinding(MemberShape member, boolean hasBody) {
        if (member.hasTrait(HttpLabelTrait.class))         return HttpBinding.PATH;
        if (member.hasTrait(HttpQueryTrait.class))         return HttpBinding.QUERY;
        if (member.hasTrait(HttpHeaderTrait.class))        return HttpBinding.HEADER;
        if (member.hasTrait(HttpPayloadTrait.class))       return HttpBinding.PAYLOAD;
        // CG-05 — catch-all map bindings, checked before the implicit fallback so
        // they aren't silently mis-bound as an ordinary query/body field.
        if (member.hasTrait(HttpQueryParamsTrait.class))   return HttpBinding.QUERY_PARAMS;
        if (member.hasTrait(HttpPrefixHeadersTrait.class)) return HttpBinding.PREFIX_HEADERS;
        return hasBody ? HttpBinding.IMPLICIT_BODY : HttpBinding.IMPLICIT_QUERY;
    }

    public static boolean isBodyMethod(String method) {
        return method.equals("POST") || method.equals("PUT") || method.equals("PATCH");
    }
}
