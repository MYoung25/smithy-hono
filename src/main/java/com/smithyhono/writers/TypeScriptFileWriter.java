package com.smithyhono.writers;

import software.amazon.smithy.build.FileManifest;
import java.util.ArrayList;
import java.util.List;

public class TypeScriptFileWriter {
    private final List<String> lines = new ArrayList<>();

    public TypeScriptFileWriter line(String text) {
        lines.add(text);
        return this;
    }

    public TypeScriptFileWriter blank() {
        lines.add("");
        return this;
    }

    public TypeScriptFileWriter comment(String text) {
        lines.add("// " + text);
        return this;
    }

    public String getContent() {
        return String.join("\n", lines) + "\n";
    }

    public void write(FileManifest manifest, String path) {
        manifest.writeFile(path, getContent());
    }

    /**
     * Renders a string as a valid double-quoted TypeScript/JSON string literal —
     * escaping backslashes, quotes, and control characters. Used for free-text the
     * model author controls (e.g. {@code @documentation}) that may contain quotes
     * or newlines and would otherwise break a single-quoted literal.
     */
    public static String stringLiteral(String value) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append("\"").toString();
    }
}
