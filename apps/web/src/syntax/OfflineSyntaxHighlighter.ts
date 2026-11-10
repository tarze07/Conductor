export type SyntaxTokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "diff-add"
  | "diff-del"
  | "diff-hunk";

export interface SyntaxToken {
  readonly kind: SyntaxTokenKind;
  readonly text: string;
}

const COMMON_KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "const",
  "let",
  "var",
  "function",
  "return",
  "async",
  "await",
  "class",
  "interface",
  "type",
  "public",
  "private",
  "readonly",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "def",
  "fn",
  "struct",
  "impl",
  "pub",
  "use",
  "package",
  "func",
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "UPDATE",
  "CREATE",
  "TABLE"
]);

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 100% Offline Syntax & Diff Highlighter with zero remote grammar or CDN dependencies.
 */
export function tokenizeCodeOffline(code: string, language = "typescript"): readonly SyntaxToken[] {
  if (language === "diff" || language === "patch") {
    return code.split("\n").map((line, idx, arr) => {
      const suffix = idx < arr.length - 1 ? "\n" : "";
      const text = `${line}${suffix}`;
      if (line.startsWith("@@")) {
        return { kind: "diff-hunk", text };
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return { kind: "diff-add", text };
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return { kind: "diff-del", text };
      }
      return { kind: "plain", text };
    });
  }

  const tokens: SyntaxToken[] = [];
  const tokenRegex =
    /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        kind: "plain",
        text: code.slice(lastIndex, match.index)
      });
    }
    const value = match[0]!;
    let kind: SyntaxTokenKind = "plain";
    if (value.startsWith("//") || value.startsWith("#")) {
      kind = "comment";
    } else if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
      kind = "string";
    } else if (/^\d/.test(value)) {
      kind = "number";
    } else if (COMMON_KEYWORDS.has(value)) {
      kind = "keyword";
    }
    tokens.push({ kind, text: value });
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < code.length) {
    tokens.push({
      kind: "plain",
      text: code.slice(lastIndex)
    });
  }

  return tokens;
}

export function renderHighlightedHtmlOffline(code: string, language = "typescript"): string {
  const tokens = tokenizeCodeOffline(code, language);
  return tokens
    .map((tok) =>
      tok.kind === "plain"
        ? escapeHtml(tok.text)
        : `<span class="tok-${tok.kind}">${escapeHtml(tok.text)}</span>`
    )
    .join("");
}
