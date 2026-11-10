import type {
  CommandReceipt,
  LinkedPullRequest,
  OrchestrationEvent,
  OrchestrationEventType,
  OutboxEffect,
  RuntimeMode,
  ThreadProjection
} from "@conductor/contracts";
import type { SqliteStateStore } from "./SqliteStateStore.js";

export interface PendingDomainEvent {
  readonly streamId: string;
  readonly type: OrchestrationEventType;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PendingOutboxEffect {
  readonly effectId: string;
  readonly type: OutboxEffect["type"];
  readonly streamId: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface OrchestrationDecision {
  readonly streamId: string;
  readonly events: readonly PendingDomainEvent[];
  readonly outboxEffects: readonly PendingOutboxEffect[];
}

export interface CommitResult {
  readonly duplicate: boolean;
  readonly receipt: CommandReceipt;
  readonly committedEvents: readonly OrchestrationEvent[];
  readonly committedEffects: readonly OutboxEffect[];
}

export type StreamSubscriber = (events: readonly OrchestrationEvent[]) => void;

export interface ProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnRecord {
  readonly turnId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly status: "running" | "completed" | "cancelled" | "failed" | "usage_limit";
  readonly checkpointRef?: string;
  readonly diffSummary?: {
    readonly filesChanged: number;
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly errorMessage?: string;
  readonly startedAt: string;
  readonly finalizedAt?: string;
}

export interface RuntimeRequestRecord {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly status: "pending" | "resolved";
  readonly selectedOptionId?: string;
  readonly messageReply?: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

/**
 * Modeled after t3code's EventSink: commits domain events, persisted projections,
 * command receipts, and outbox effects in a single atomic SQLite transaction.
 * Subscribers are notified only after the transaction commits.
 */
export class EventSink {
  private readonly store: SqliteStateStore;
  private readonly subscribers = new Map<string, Set<StreamSubscriber>>();

  constructor(store: SqliteStateStore) {
    this.store = store;
  }

  public getReceipt(commandId: string): CommandReceipt | undefined {
    const row = this.store.db
      .prepare(
        "SELECT command_id, stream_id, result_seq, created_at FROM command_receipts WHERE command_id = ?"
      )
      .get(commandId) as
      | {
          command_id: string;
          stream_id: string;
          result_seq: number;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      commandId: row.command_id,
      streamId: row.stream_id,
      resultSeq: Number(row.result_seq),
      createdAt: row.created_at
    };
  }

  public commitCommand(
    commandId: string,
    issuedAt: string,
    decision: OrchestrationDecision
  ): CommitResult {
    const result = this.store.inTransaction<CommitResult>(() => {
      const existingReceipt = this.getReceipt(commandId);
      if (existingReceipt) {
        return {
          duplicate: true,
          receipt: existingReceipt,
          committedEvents: [],
          committedEffects: []
        };
      }

      const committedEvents: OrchestrationEvent[] = [];
      let lastSeq = 0;

      const maxVersionStmt = this.store.db.prepare(
        "SELECT COALESCE(MAX(stream_version), 0) AS max_ver FROM events WHERE stream_id = ?"
      );
      const insertEventStmt = this.store.db.prepare(
        `INSERT INTO events (stream_id, stream_version, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );

      for (const pending of decision.events) {
        const verRow = maxVersionStmt.get(pending.streamId) as { max_ver: number };
        const nextVersion = Number(verRow.max_ver) + 1;
        const insertRes = insertEventStmt.run(
          pending.streamId,
          nextVersion,
          pending.type,
          JSON.stringify(pending.payload),
          pending.createdAt
        );
        const seq = Number(insertRes.lastInsertRowid);
        lastSeq = seq;

        const event: OrchestrationEvent = {
          seq,
          streamId: pending.streamId,
          streamVersion: nextVersion,
          type: pending.type,
          payload: pending.payload,
          createdAt: pending.createdAt
        };
        committedEvents.push(event);
        this.applyProjection(event);
      }

      const receipt: CommandReceipt = {
        commandId,
        streamId: decision.streamId,
        resultSeq: lastSeq,
        createdAt: issuedAt
      };

      this.store.db
        .prepare(
          `INSERT INTO command_receipts (command_id, stream_id, result_seq, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(receipt.commandId, receipt.streamId, receipt.resultSeq, receipt.createdAt);

      const committedEffects: OutboxEffect[] = [];
      const insertOutboxStmt = this.store.db.prepare(
        `INSERT INTO outbox (effect_id, type, stream_id, payload_json, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`
      );

      for (const eff of decision.outboxEffects) {
        insertOutboxStmt.run(
          eff.effectId,
          eff.type,
          eff.streamId,
          JSON.stringify(eff.payload),
          eff.createdAt
        );
        committedEffects.push({
          effectId: eff.effectId,
          type: eff.type,
          streamId: eff.streamId,
          payload: eff.payload,
          status: "pending",
          attempts: 0,
          createdAt: eff.createdAt
        });
      }

      return {
        duplicate: false,
        receipt,
        committedEvents,
        committedEffects
      };
    });

    if (!result.duplicate && result.committedEvents.length > 0) {
      this.notifySubscribers(decision.streamId, result.committedEvents);
    }

    return result;
  }

  public appendStreamEvents(events: readonly PendingDomainEvent[]): readonly OrchestrationEvent[] {
    if (events.length === 0) {
      return [];
    }

    const committed = this.store.inTransaction<OrchestrationEvent[]>(() => {
      const out: OrchestrationEvent[] = [];
      const maxVersionStmt = this.store.db.prepare(
        "SELECT COALESCE(MAX(stream_version), 0) AS max_ver FROM events WHERE stream_id = ?"
      );
      const insertEventStmt = this.store.db.prepare(
        `INSERT INTO events (stream_id, stream_version, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );

      for (const pending of events) {
        const verRow = maxVersionStmt.get(pending.streamId) as { max_ver: number };
        const nextVersion = Number(verRow.max_ver) + 1;
        const insertRes = insertEventStmt.run(
          pending.streamId,
          nextVersion,
          pending.type,
          JSON.stringify(pending.payload),
          pending.createdAt
        );
        const seq = Number(insertRes.lastInsertRowid);
        const ev: OrchestrationEvent = {
          seq,
          streamId: pending.streamId,
          streamVersion: nextVersion,
          type: pending.type,
          payload: pending.payload,
          createdAt: pending.createdAt
        };
        out.push(ev);
        this.applyProjection(ev);
      }
      return out;
    });

    const byStream = new Map<string, OrchestrationEvent[]>();
    for (const ev of committed) {
      const list = byStream.get(ev.streamId) ?? [];
      list.push(ev);
      byStream.set(ev.streamId, list);
    }
    for (const [streamId, streamEvents] of byStream.entries()) {
      this.notifySubscribers(streamId, streamEvents);
    }

    return committed;
  }

  public subscribe(streamId: string, listener: StreamSubscriber): () => void {
    let set = this.subscribers.get(streamId);
    if (!set) {
      set = new Set();
      this.subscribers.set(streamId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.subscribers.delete(streamId);
      }
    };
  }

  private notifySubscribers(streamId: string, events: readonly OrchestrationEvent[]): void {
    const listeners = this.subscribers.get(streamId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(events);
    }
  }

  private applyProjection(event: OrchestrationEvent): void {
    const p = event.payload;
    switch (event.type) {
      case "project.registered": {
        this.store.db
          .prepare(
            `INSERT INTO projections_projects (project_id, name, root_path, default_branch, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               name = excluded.name,
               root_path = excluded.root_path,
               default_branch = excluded.default_branch,
               updated_at = excluded.updated_at`
          )
          .run(
            String(p.projectId),
            String(p.name),
            String(p.rootPath),
            String(p.defaultBranch ?? "main"),
            event.createdAt,
            event.createdAt
          );
        break;
      }

      case "thread.created": {
        this.store.db
          .prepare(
            `INSERT INTO projections_threads (
               thread_id, project_id, title, provider_instance_id, model,
               runtime_mode, status, last_event_seq, pruned_through_seq,
               pull_requests_json, worktree_branch, link_origin_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 0, '[]', ?, ?, ?)`
          )
          .run(
            String(p.threadId),
            String(p.projectId),
            String(p.title),
            String(p.providerInstanceId),
            String(p.model),
            String(p.runtimeMode),
            event.seq,
            p.worktreeBranch ? String(p.worktreeBranch) : null,
            p.linkOrigin ? JSON.stringify(p.linkOrigin) : null,
            event.createdAt
          );
        break;
      }

      case "thread.settled": {
        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = 'settled', last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, String(p.settledAt ?? event.createdAt), String(p.threadId));
        break;
      }

      case "turn.started": {
        this.store.db
          .prepare(
            `INSERT INTO projections_turns (turn_id, thread_id, prompt, status, started_at)
             VALUES (?, ?, ?, 'running', ?)`
          )
          .run(String(p.turnId), String(p.threadId), String(p.prompt), event.createdAt);

        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = 'running', last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, event.createdAt, String(p.threadId));
        break;
      }

      case "runtime-request.opened": {
        this.store.db
          .prepare(
            `INSERT INTO projections_runtime_requests (
               request_id, thread_id, turn_id, question, options_json, status, created_at
             ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
          )
          .run(
            String(p.requestId),
            String(p.threadId),
            String(p.turnId),
            String(p.question),
            JSON.stringify(p.options ?? []),
            event.createdAt
          );

        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = 'awaiting_input', last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, event.createdAt, String(p.threadId));
        break;
      }

      case "runtime-request.resolved": {
        this.store.db
          .prepare(
            `UPDATE projections_runtime_requests
             SET status = 'resolved', selected_option_id = ?, message_reply = ?, resolved_at = ?
             WHERE request_id = ?`
          )
          .run(
            String(p.selectedOptionId),
            p.messageReply ? String(p.messageReply) : null,
            event.createdAt,
            String(p.requestId)
          );

        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = 'idle', last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, event.createdAt, String(p.threadId));
        break;
      }

      case "checkpoint.captured": {
        this.store.db
          .prepare(
            `UPDATE projections_turns
             SET checkpoint_ref = ?, diff_summary_json = COALESCE(?, diff_summary_json)
             WHERE turn_id = ?`
          )
          .run(
            String(p.checkpointRef),
            p.diffSummary ? JSON.stringify(p.diffSummary) : null,
            String(p.turnId)
          );

        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, event.createdAt, String(p.threadId));
        break;
      }

      case "checkpoint.restored": {
        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = 'idle', last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(event.seq, event.createdAt, String(p.threadId));
        break;
      }

      case "turn.completed":
      case "turn.failed": {
        const turnStatus = String(p.status ?? (event.type === "turn.failed" ? "failed" : "completed"));
        const threadStatus = turnStatus === "failed" ? "failed" : "idle";
        this.store.db
          .prepare(
            `UPDATE projections_turns
             SET status = ?,
                 checkpoint_ref = COALESCE(?, checkpoint_ref),
                 diff_summary_json = COALESCE(?, diff_summary_json),
                 error_message = COALESCE(?, error_message),
                 finalized_at = ?
             WHERE turn_id = ?`
          )
          .run(
            turnStatus,
            p.checkpointRef ? String(p.checkpointRef) : null,
            p.diffSummary ? JSON.stringify(p.diffSummary) : null,
            p.errorMessage ? String(p.errorMessage) : null,
            event.createdAt,
            String(p.turnId)
          );

        this.store.db
          .prepare(
            `UPDATE projections_threads
             SET status = ?, last_event_seq = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(threadStatus, event.seq, event.createdAt, String(p.threadId));
        break;
      }

      default: {
        // Stream events like message.delta, tool.call.started, tool.call.completed advance thread's last_event_seq
        if (typeof p.threadId === "string") {
          this.store.db
            .prepare(
              `UPDATE projections_threads
               SET last_event_seq = ?, updated_at = ?
               WHERE thread_id = ?`
            )
            .run(event.seq, event.createdAt, p.threadId);
        }
        break;
      }
    }
  }

  public getProject(projectId: string): ProjectRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT project_id, name, root_path, default_branch, created_at, updated_at
         FROM projections_projects WHERE project_id = ?`
      )
      .get(projectId) as
      | {
          project_id: string;
          name: string;
          root_path: string;
          default_branch: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      projectId: row.project_id,
      name: row.name,
      rootPath: row.root_path,
      defaultBranch: row.default_branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public listProjects(): readonly ProjectRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT project_id, name, root_path, default_branch, created_at, updated_at
         FROM projections_projects ORDER BY updated_at DESC`
      )
      .all() as Array<{
      project_id: string;
      name: string;
      root_path: string;
      default_branch: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      rootPath: row.root_path,
      defaultBranch: row.default_branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public getThread(threadId: string): ThreadProjection | undefined {
    const row = this.store.db
      .prepare(
        `SELECT thread_id, project_id, title, provider_instance_id, model,
                runtime_mode, status, last_event_seq, pruned_through_seq,
                pull_requests_json, updated_at
         FROM projections_threads WHERE thread_id = ?`
      )
      .get(threadId) as
      | {
          thread_id: string;
          project_id: string;
          title: string;
          provider_instance_id: string;
          model: string;
          runtime_mode: RuntimeMode;
          status: ThreadProjection["status"];
          last_event_seq: number;
          pruned_through_seq: number;
          pull_requests_json: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      threadId: row.thread_id,
      projectId: row.project_id,
      title: row.title,
      providerInstanceId: row.provider_instance_id,
      model: row.model,
      runtimeMode: row.runtime_mode,
      status: row.status,
      lastEventSeq: Number(row.last_event_seq),
      prunedThroughSeq: Number(row.pruned_through_seq),
      pullRequests: JSON.parse(row.pull_requests_json) as LinkedPullRequest[],
      updatedAt: row.updated_at
    };
  }

  public listThreads(projectId?: string): readonly ThreadProjection[] {
    const rows = (
      projectId
        ? this.store.db
            .prepare(
              `SELECT thread_id, project_id, title, provider_instance_id, model,
                      runtime_mode, status, last_event_seq, pruned_through_seq,
                      pull_requests_json, updated_at
               FROM projections_threads WHERE project_id = ? ORDER BY updated_at DESC`
            )
            .all(projectId)
        : this.store.db
            .prepare(
              `SELECT thread_id, project_id, title, provider_instance_id, model,
                      runtime_mode, status, last_event_seq, pruned_through_seq,
                      pull_requests_json, updated_at
               FROM projections_threads ORDER BY updated_at DESC`
            )
            .all()
    ) as Array<{
      thread_id: string;
      project_id: string;
      title: string;
      provider_instance_id: string;
      model: string;
      runtime_mode: RuntimeMode;
      status: ThreadProjection["status"];
      last_event_seq: number;
      pruned_through_seq: number;
      pull_requests_json: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      title: row.title,
      providerInstanceId: row.provider_instance_id,
      model: row.model,
      runtimeMode: row.runtime_mode,
      status: row.status,
      lastEventSeq: Number(row.last_event_seq),
      prunedThroughSeq: Number(row.pruned_through_seq),
      pullRequests: JSON.parse(row.pull_requests_json) as LinkedPullRequest[],
      updatedAt: row.updated_at
    }));
  }

  public getTurn(turnId: string): TurnRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT turn_id, thread_id, prompt, status, checkpoint_ref, diff_summary_json,
                error_message, started_at, finalized_at
         FROM projections_turns WHERE turn_id = ?`
      )
      .get(turnId) as
      | {
          turn_id: string;
          thread_id: string;
          prompt: string;
          status: TurnRecord["status"];
          checkpoint_ref: string | null;
          diff_summary_json: string | null;
          error_message: string | null;
          started_at: string;
          finalized_at: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      turnId: row.turn_id,
      threadId: row.thread_id,
      prompt: row.prompt,
      status: row.status,
      checkpointRef: row.checkpoint_ref ?? undefined,
      diffSummary: row.diff_summary_json ? JSON.parse(row.diff_summary_json) : undefined,
      errorMessage: row.error_message ?? undefined,
      startedAt: row.started_at,
      finalizedAt: row.finalized_at ?? undefined
    };
  }

  public getRuntimeRequest(requestId: string): RuntimeRequestRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT request_id, thread_id, turn_id, question, options_json, status,
                selected_option_id, message_reply, created_at, resolved_at
         FROM projections_runtime_requests WHERE request_id = ?`
      )
      .get(requestId) as
      | {
          request_id: string;
          thread_id: string;
          turn_id: string;
          question: string;
          options_json: string;
          status: "pending" | "resolved";
          selected_option_id: string | null;
          message_reply: string | null;
          created_at: string;
          resolved_at: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      requestId: row.request_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      question: row.question,
      options: JSON.parse(row.options_json),
      status: row.status,
      selectedOptionId: row.selected_option_id ?? undefined,
      messageReply: row.message_reply ?? undefined,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined
    };
  }

  public getEventsForStream(streamId: string, afterSeq = 0): readonly OrchestrationEvent[] {
    const rows = this.store.db
      .prepare(
        `SELECT seq, stream_id, stream_version, type, payload_json, created_at
         FROM events
         WHERE stream_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(streamId, afterSeq) as Array<{
      seq: number;
      stream_id: string;
      stream_version: number;
      type: OrchestrationEventType;
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      seq: Number(row.seq),
      streamId: row.stream_id,
      streamVersion: Number(row.stream_version),
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }
}
