package com.smithyhono.writers;

public enum HttpBinding {
    PATH, QUERY, HEADER, PAYLOAD, IMPLICIT_BODY, IMPLICIT_QUERY,
    // CG-05 — catch-all map bindings.
    QUERY_PARAMS,   // @httpQueryParams: all query params as a map
    PREFIX_HEADERS  // @httpPrefixHeaders("prefix-"): prefix-matched headers as a map
}
