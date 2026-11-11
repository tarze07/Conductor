import {
  DEFAULT_MODEL_SENTINEL,
  type OrchestrationEvent,
  type ProviderPresentation,
  type RuntimeMode,
  type ThreadProjection
} from "@conductor/contracts";

export interface ComposerFileReference {
  readonly token: string;
  readonly relativePath: string;
}

export interface TimelineItem {
  readonly id: string;
  readonly kind: "user_prompt" | "assistant_message" | "tool_call" | "runtime_request" | "checkpoint";
  readonly turnId: string;
  readonly title: string;
  readonly body: string;
  readonly status?: string;
  readonly checkpointRef?: string;
  readonly requestId?: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Extracts `@path/to/file.ext` workspace file references from the prompt composer text.
 */
export function extractComposerFileReferences(promptText: string): readonly ComposerFileReference[] {
  const regex = /(?:^|\s)@([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g;
  const seen = new Set<string>();
  const refs: ComposerFileReference[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(promptText)) !== null) {
    const rel = match[1]!;
    if (!seen.has(rel)) {
      seen.add(rel);
      refs.push({
        token: `@${rel}`,
        relativePath: rel
      });
    }
  }

  return refs;
}

/**
 * Formats model label for UI selectors, converting `DEFAULT_MODEL_SENTINEL` (`"__DEFAULT_MODEL__"`)
 * into a human-friendly label while preserving explicit model names.
 */
export function formatModelSelectionLabel(model: string, instanceDefaultModel?: string): string {
  if (model === DEFAULT_MODEL_SENTINEL) {
    return instanceDefaultModel && instanceDefaultModel !== DEFAULT_MODEL_SENTINEL
      ? `Domyślny (${instanceDefaultModel})`
      : "Domyślny model instancji";
  }
  return model;
}

/**
 * Builds a flat, virtualizable timeline of items from a thread's domain events.
 */
export function buildThreadTimelineFromEvents(
  events: readonly OrchestrationEvent[]
): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  const assistantIndexByTurn = new Map<string, number>();
  const toolCallIndexById = new Map<string, number>();
  const requestIndexById = new Map<string, number>();

  for (const ev of events) {
    const p = ev.payload;
    const turnId = String(p.turnId ?? "turn_unknown");

    switch (ev.type) {
      case "turn.started": {
        items.push({
          id: `prompt_${turnId}`,
          kind: "user_prompt",
          turnId,
          title: "Prompt użytkownika",
          body: String(p.prompt ?? "")
        });
        break;
      }

      case "message.delta": {
        const delta = String(p.textDelta ?? "");
        const existingIdx = assistantIndexByTurn.get(turnId);
        if (existingIdx !== undefined) {
          const prev = items[existingIdx]!;
          items[existingIdx] = {
            ...prev,
            body: prev.body + delta
          };
        } else {
          assistantIndexByTurn.set(turnId, items.length);
          items.push({
            id: `msg_${turnId}`,
            kind: "assistant_message",
            turnId,
            title: "Odpowiedź agenta",
            body: delta
          });
        }
        break;
      }

      case "tool.call.started": {
        const toolCallId = String(p.toolCallId ?? `tc_${ev.seq}`);
        const toolName = String(p.toolName ?? "tool");
        toolCallIndexById.set(toolCallId, items.length);
        items.push({
          id: `tool_${toolCallId}`,
          kind: "tool_call",
          turnId,
          title: `Narzędzie: ${toolName}`,
          body: JSON.stringify(p.args ?? {}, null, 2),
          status: "running"
        });
        break;
      }

      case "tool.call.completed": {
        const toolCallId = String(p.toolCallId ?? "");
        const idx = toolCallIndexById.get(toolCallId);
        if (idx !== undefined) {
          const prev = items[idx]!;
          items[idx] = {
            ...prev,
            body: `${prev.body}\n→ Wynik: ${JSON.stringify(p.result ?? {})}`,
            status: "completed"
          };
        }
        break;
      }

      case "runtime-request.opened": {
        const requestId = String(p.requestId ?? `req_${ev.seq}`);
        requestIndexById.set(requestId, items.length);
        items.push({
          id: `req_${requestId}`,
          kind: "runtime_request",
          turnId,
          title: "Wymagana autoryzacja operacji",
          body: String(p.question ?? ""),
          status: "pending",
          requestId,
          options: (p.options as Array<{ id: string; label: string }>) ?? []
        });
        break;
      }

      case "runtime-request.resolved": {
        const requestId = String(p.requestId ?? "");
        const idx = requestIndexById.get(requestId);
        if (idx !== undefined) {
          const prev = items[idx]!;
          items[idx] = {
            ...prev,
            status: `resolved:${String(p.selectedOptionId ?? "")}`
          };
        }
        break;
      }

      case "checkpoint.captured": {
        const checkpointRef = String(p.checkpointRef ?? "");
        items.push({
          id: `ckpt_${turnId}`,
          kind: "checkpoint",
          turnId,
          title: "Punkt kontrolny Git (Checkpoint)",
          body: checkpointRef,
          checkpointRef
        });
        break;
      }
    }
  }

  return items;
}

export class WebUiStore {
  private activeEnvironmentId = "env_local";
  private draftPrompt = "";
  private selectedModel: string = DEFAULT_MODEL_SENTINEL;
  private selectedRuntimeMode: RuntimeMode = "supervised";
  private activePresentation?: ProviderPresentation;
  private activeThread?: ThreadProjection;
  private timeline: readonly TimelineItem[] = [];
  private terminalBuffer = "";

  public setActiveEnvironmentId(envId: string): void {
    this.activeEnvironmentId = envId;
  }

  public getActiveEnvironmentId(): string {
    return this.activeEnvironmentId;
  }

  public setProviderPresentation(presentation: ProviderPresentation): void {
    this.activePresentation = presentation;
    if (!presentation.supportedRuntimeModes.includes(this.selectedRuntimeMode)) {
      this.selectedRuntimeMode = "supervised";
    }
  }

  public getAvailableRuntimeModes(): readonly RuntimeMode[] {
    if (!this.activePresentation || !this.activePresentation.showInteractionModeToggle) {
      return ["supervised"];
    }
    return this.activePresentation.supportedRuntimeModes;
  }

  public setSelectedRuntimeMode(mode: RuntimeMode): void {
    const allowed = this.getAvailableRuntimeModes();
    this.selectedRuntimeMode = allowed.includes(mode) ? mode : "supervised";
  }

  public getSelectedRuntimeMode(): RuntimeMode {
    return this.selectedRuntimeMode;
  }

  public setSelectedModel(model: string): void {
    this.selectedModel = model || DEFAULT_MODEL_SENTINEL;
  }

  public getSelectedModel(): string {
    return this.selectedModel;
  }

  public setDraftPrompt(text: string): void {
    this.draftPrompt = text;
  }

  public getDraftPrompt(): string {
    return this.draftPrompt;
  }

  public getDraftFileReferences(): readonly ComposerFileReference[] {
    return extractComposerFileReferences(this.draftPrompt);
  }

  public applyThreadStreamUpdate(
    snapshot: ThreadProjection | undefined,
    events: readonly OrchestrationEvent[]
  ): void {
    if (snapshot) {
      this.activeThread = snapshot;
    }
    this.timeline = buildThreadTimelineFromEvents(events);
  }

  public getActiveThread(): ThreadProjection | undefined {
    return this.activeThread;
  }

  public getTimeline(): readonly TimelineItem[] {
    return this.timeline;
  }

  public appendTerminalOutput(chunk: string): void {
    this.terminalBuffer += chunk;
  }

  public getTerminalBuffer(): string {
    return this.terminalBuffer;
  }
}
