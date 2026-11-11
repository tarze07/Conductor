export interface OfflineWebAssetEntry {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Generates the complete, 100% self-contained single-origin Web UI asset bundle.
 * Zero external requests: all stylesheets, scripts, icons, and syntax tokenizers
 * are served from the local Conductor daemon under `STRICT_OFFLINE_CSP`.
 */
export function buildOfflineWebAssets(options?: {
  readonly defaultEnvironmentId?: string;
}): Readonly<Record<string, OfflineWebAssetEntry>> {
  const envId = options?.defaultEnvironmentId ?? "env_local";

  const indexHtml = `<!DOCTYPE html>
<html lang="pl" data-conductor-offline="true" data-environment-id="${envId}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conductor — Intranet AI Coding Studio (Offline Mode)</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <div id="conductor-root" class="app-shell">
    <aside class="sidebar" aria-label="Projekty i wątki">
      <header class="sidebar-header">
        <span class="brand-badge">CONDUCTOR</span>
        <span class="offline-pill">ZERO-INTERNET</span>
      </header>
      <section class="sidebar-section">
        <h2 class="section-title">Środowiska i Projekty</h2>
        <div id="projects-list" class="item-list"></div>
      </section>
      <section class="sidebar-section">
        <h2 class="section-title">Wątki Agenta</h2>
        <div id="threads-list" class="item-list"></div>
      </section>
    </aside>

    <main class="workspace-main">
      <header class="workspace-topbar">
        <div id="active-thread-title" class="thread-title">Wybierz lub utwórz wątek</div>
        <div class="topbar-controls">
          <span id="env-indicator" class="meta-chip">Środowisko: ${envId}</span>
          <button id="btn-toggle-diff" type="button" class="btn-secondary">Checkpoint Diff / Rollback</button>
          <button id="btn-toggle-terminal" type="button" class="btn-secondary">Terminal PTY</button>
        </div>
      </header>

      <section id="virtual-thread-viewport" class="thread-viewport" aria-label="Historia tury i wywołań narzędzi">
        <div id="virtual-top-spacer"></div>
        <div id="virtual-items-container"></div>
        <div id="virtual-bottom-spacer"></div>
      </section>

      <section id="approval-banner" class="approval-banner hidden" role="region" aria-label="Autoryzacja operacji"></section>

      <section id="diff-panel" class="drawer-panel hidden" aria-label="Przeglądarka Checkpoint Diff"></section>

      <section id="terminal-panel" class="drawer-panel hidden" aria-label="Zintegrowany Terminal PTY">
        <pre id="terminal-output" class="terminal-screen"></pre>
      </section>

      <footer class="composer-bar">
        <div class="composer-toolbar">
          <label class="toolbar-field">
            <span>Tryb:</span>
            <select id="runtime-mode-select">
              <option value="plan-only">Plan-Only (Tylko odczyt)</option>
              <option value="supervised" selected>Supervised (Zatwierdzanie)</option>
              <option value="autonomous-sandbox">Autonomous Sandbox</option>
            </select>
          </label>
          <label class="toolbar-field">
            <span>Model:</span>
            <select id="model-select">
              <option value="__DEFAULT_MODEL__">Domyślny model instancji</option>
            </select>
          </label>
          <div id="file-ref-chips" class="file-ref-chips"></div>
        </div>
        <div class="composer-input-row">
          <textarea
            id="prompt-textarea"
            rows="3"
            placeholder="Opisz zadanie inżynieryjne (użyj @ścieżka/do/pliku.ts aby dołączyć kontekst)..."
          ></textarea>
          <button id="btn-send-turn" type="button" class="btn-primary">Uruchom turę</button>
        </div>
      </footer>
    </main>
  </div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;

  const appCss = `:root {
  --bg-primary: #0f141c;
  --bg-elevated: #171f2c;
  --bg-panel: #1e293b;
  --text-primary: #f1f5f9;
  --text-muted: #94a3b8;
  --accent: #38bdf8;
  --accent-ok: #22c55e;
  --accent-warn: #f59e0b;
  --accent-err: #ef4444;
  --border-subtle: #334155;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-sans);
}

.app-shell {
  display: grid;
  grid-template-columns: 280px 1fr;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  background-color: var(--bg-elevated);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.brand-badge {
  font-weight: 700;
  letter-spacing: 0.06em;
}

.offline-pill {
  font-size: 11px;
  font-family: var(--font-mono);
  background-color: #064e3b;
  color: #6ee7b7;
  padding: 2px 6px;
  border-radius: 4px;
}

.workspace-main {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background-color: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
}

.thread-viewport {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  contain: content;
}

.composer-bar {
  background-color: var(--bg-elevated);
  border-top: 1px solid var(--border-subtle);
  padding: 12px 16px;
}

.composer-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}

.composer-input-row {
  display: flex;
  gap: 8px;
}

#prompt-textarea {
  flex: 1;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px;
  font-family: var(--font-mono);
}

.btn-primary {
  background-color: var(--accent);
  color: #090d16;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary {
  background-color: var(--bg-panel);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
}

.hidden {
  display: none;
}

.tok-keyword { color: #c084fc; font-weight: 600; }
.tok-string { color: #86efac; }
.tok-comment { color: #64748b; font-style: italic; }
.tok-number { color: #fca5a5; }
.tok-diff-add { background-color: rgba(34, 197, 94, 0.18); color: #86efac; display: block; }
.tok-diff-del { background-color: rgba(239, 68, 68, 0.18); color: #fca5a5; display: block; }
.tok-diff-hunk { color: #38bdf8; font-weight: 600; display: block; }
`;

  const appJs = `// Conductor 100% Offline Client Bootstrap (Zero External Dependencies)
(function bootstrapConductorOfflineUi() {
  const promptInput = document.getElementById("prompt-textarea");
  const refChips = document.getElementById("file-ref-chips");

  if (promptInput && refChips) {
    promptInput.addEventListener("input", () => {
      const text = promptInput.value || "";
      const matches = text.match(/(?:^|\\s)@([A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)\\b/g) || [];
      refChips.textContent = matches.map((m) => m.trim()).join(" ");
    });
  }
})();
`;

  const iconsSvg = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="icon-shield" viewBox="0 0 24 24">
    <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z"/>
  </symbol>
  <symbol id="icon-terminal" viewBox="0 0 24 24">
    <path d="M4 4h16v16H4V4zm3 4l4 4-4 4 1.4 1.4L13.8 12 8.4 6.6 7 8zm6 8h5v-2h-5v2z"/>
  </symbol>
</svg>`;

  return {
    "/": { contentType: "text/html; charset=utf-8", body: indexHtml },
    "/index.html": { contentType: "text/html; charset=utf-8", body: indexHtml },
    "/assets/app.css": { contentType: "text/css; charset=utf-8", body: appCss },
    "/assets/app.js": { contentType: "application/javascript; charset=utf-8", body: appJs },
    "/assets/icons.svg": { contentType: "image/svg+xml; charset=utf-8", body: iconsSvg }
  };
}
