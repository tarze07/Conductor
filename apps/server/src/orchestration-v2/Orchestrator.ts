import {
  OrchestrationCommandSchema,
  type OrchestrationCommand
} from "@conductor/contracts";
import type {
  CommitResult,
  EventSink,
  OrchestrationDecision,
  PendingDomainEvent,
  PendingOutboxEffect
} from "../persistence/EventSink.js";
import type { EffectWorker } from "./EffectWorker.js";

export class OrchestrationRejectedError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationRejectedError";
    this.code = code;
  }
}

/**
 * Modeled after t3code's v2 Orchestrator:
 * Serializes commands, checks idempotency receipts first, decides events and outbox
 * effects purely without performing external I/O, commits them atomically via EventSink,
 * and hands committed outbox effects to EffectWorker.
 */
export class OrchestratorV2 {
  private readonly sink: EventSink;
  private effectWorker?: EffectWorker;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  public attachEffectWorker(worker: EffectWorker): void {
    this.effectWorker = worker;
  }

  public dispatch(rawCommand: OrchestrationCommand): CommitResult {
    const command = OrchestrationCommandSchema.parse(rawCommand);

    // Check receipt first so idempotent retries succeed even after projections have advanced
    const existingReceipt = this.sink.getReceipt(command.commandId);
    if (existingReceipt) {
      return {
        duplicate: true,
        receipt: existingReceipt,
        committedEvents: [],
        committedEffects: []
      };
    }

    const decision = this.decide(command);
    const result = this.sink.commitCommand(command.commandId, command.issuedAt, decision);

    if (!result.duplicate && result.committedEffects.length > 0 && this.effectWorker) {
      this.effectWorker.enqueueEffects(result.committedEffects);
    }

    return result;
  }

  /**
   * Pure decision function: inspects current projections and produces domain events + outbox effects
   * without performing any filesystem, Git, or network I/O.
   */
  public decide(command: OrchestrationCommand): OrchestrationDecision {
    const now = command.issuedAt;

    switch (command.type) {
      case "project.register": {
        const { projectId, name, rootPath, defaultBranch } = command.payload;
        return {
          streamId: `project:${projectId}`,
          events: [
            {
              streamId: `project:${projectId}`,
              type: "project.registered",
              payload: { projectId, name, rootPath, defaultBranch },
              createdAt: now
            }
          ],
          outboxEffects: []
        };
      }

      case "thread.create": {
        const {
          threadId,
          projectId,
          title,
          providerInstanceId,
          model,
          runtimeMode,
          worktreeBranch,
          linkOrigin
        } = command.payload;

        const project = this.sink.getProject(projectId);
        if (!project) {
          throw new OrchestrationRejectedError(
            "ERR_PROJECT_NOT_FOUND",
            `Cannot create thread '${threadId}': project '${projectId}' is not registered`
          );
        }

        if (this.sink.getThread(threadId)) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_ALREADY_EXISTS",
            `Thread '${threadId}' already exists`
          );
        }

        return {
          streamId: threadId,
          events: [
            {
              streamId: threadId,
              type: "thread.created",
              payload: {
                threadId,
                projectId,
                title,
                providerInstanceId,
                model,
                runtimeMode,
                worktreeBranch,
                linkOrigin
              },
              createdAt: now
            }
          ],
          outboxEffects: []
        };
      }

      case "thread.auto-settle": {
        const { threadId, reason, settledAt } = command.payload;
        const thread = this.sink.getThread(threadId);
        if (!thread) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_NOT_FOUND",
            `Thread '${threadId}' not found`
          );
        }

        if (thread.status === "running" || thread.status === "awaiting_input") {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_ACTIVE_WORK",
            `Cannot auto-settle thread '${threadId}' while status is '${thread.status}'`
          );
        }

        if (settledAt < thread.updatedAt) {
          throw new OrchestrationRejectedError(
            "ERR_STALE_SETTLEMENT",
            `Cannot auto-settle thread '${threadId}': newer activity exists at '${thread.updatedAt}'`
          );
        }

        return {
          streamId: threadId,
          events: [
            {
              streamId: threadId,
              type: "thread.settled",
              payload: { threadId, reason, settledAt },
              createdAt: now
            }
          ],
          outboxEffects: []
        };
      }

      case "turn.start": {
        const { threadId, turnId, prompt, attachmentIds } = command.payload;
        const thread = this.sink.getThread(threadId);
        if (!thread) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_NOT_FOUND",
            `Thread '${threadId}' not found`
          );
        }

        if (thread.status === "running") {
          throw new OrchestrationRejectedError(
            "ERR_TURN_ALREADY_RUNNING",
            `Thread '${threadId}' already has an active turn`
          );
        }

        const events: PendingDomainEvent[] = [
          {
            streamId: threadId,
            type: "turn.started",
            payload: {
              threadId,
              turnId,
              prompt,
              attachmentIds,
              providerInstanceId: thread.providerInstanceId,
              model: thread.model,
              runtimeMode: thread.runtimeMode
            },
            createdAt: now
          }
        ];

        const outboxEffects: PendingOutboxEffect[] = [
          {
            effectId: `eff_run_${turnId}`,
            type: "provider.run_turn",
            streamId: threadId,
            payload: {
              threadId,
              turnId,
              projectId: thread.projectId,
              prompt,
              attachmentIds,
              providerInstanceId: thread.providerInstanceId,
              model: thread.model,
              runtimeMode: thread.runtimeMode
            },
            createdAt: now
          }
        ];

        return {
          streamId: threadId,
          events,
          outboxEffects
        };
      }

      case "turn.cancel": {
        const { threadId, turnId, reason } = command.payload;
        const thread = this.sink.getThread(threadId);
        if (!thread) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_NOT_FOUND",
            `Thread '${threadId}' not found`
          );
        }

        return {
          streamId: threadId,
          events: [
            {
              streamId: threadId,
              type: "turn.completed",
              payload: {
                threadId,
                turnId,
                status: "cancelled",
                reason: reason ?? "user_cancelled"
              },
              createdAt: now
            }
          ],
          outboxEffects: [
            {
              effectId: `eff_cancel_${turnId}_${command.commandId}`,
              type: "provider.cancel_turn",
              streamId: threadId,
              payload: { threadId, turnId, reason: reason ?? "user_cancelled" },
              createdAt: now
            }
          ]
        };
      }

      case "turn.finalize": {
        const { threadId, turnId, status, checkpointRef, diffSummary, errorMessage } =
          command.payload;
        const thread = this.sink.getThread(threadId);
        if (!thread) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_NOT_FOUND",
            `Thread '${threadId}' not found`
          );
        }

        const events: PendingDomainEvent[] = [];
        if (checkpointRef) {
          events.push({
            streamId: threadId,
            type: "checkpoint.captured",
            payload: {
              threadId,
              turnId,
              checkpointRef,
              diffSummary
            },
            createdAt: now
          });
        }

        events.push({
          streamId: threadId,
          type: status === "failed" ? "turn.failed" : "turn.completed",
          payload: {
            threadId,
            turnId,
            status,
            checkpointRef,
            diffSummary,
            errorMessage
          },
          createdAt: now
        });

        return {
          streamId: threadId,
          events,
          outboxEffects: []
        };
      }

      case "checkpoint.restore": {
        const { threadId, targetTurnId, checkpointRef } = command.payload;
        const thread = this.sink.getThread(threadId);
        if (!thread) {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_NOT_FOUND",
            `Thread '${threadId}' not found`
          );
        }

        if (thread.status === "running") {
          throw new OrchestrationRejectedError(
            "ERR_THREAD_ACTIVE_WORK",
            `Cannot restore checkpoint while thread '${threadId}' has an active turn`
          );
        }

        return {
          streamId: threadId,
          events: [
            {
              streamId: threadId,
              type: "checkpoint.restored",
              payload: {
                threadId,
                targetTurnId,
                checkpointRef
              },
              createdAt: now
            }
          ],
          outboxEffects: [
            {
              effectId: `eff_restore_${command.commandId}`,
              type: "checkpoint.restore",
              streamId: threadId,
              payload: {
                threadId,
                projectId: thread.projectId,
                targetTurnId,
                checkpointRef,
                providerInstanceId: thread.providerInstanceId
              },
              createdAt: now
            }
          ]
        };
      }

      case "runtime-request.respond": {
        const { threadId, requestId, selectedOptionId, messageReply } = command.payload;
        const reqRecord = this.sink.getRuntimeRequest(requestId);
        if (!reqRecord || reqRecord.threadId !== threadId) {
          throw new OrchestrationRejectedError(
            "ERR_RUNTIME_REQUEST_NOT_FOUND",
            `Runtime request '${requestId}' not found on thread '${threadId}'`
          );
        }

        if (reqRecord.status !== "pending") {
          throw new OrchestrationRejectedError(
            "ERR_RUNTIME_REQUEST_ALREADY_RESOLVED",
            `Runtime request '${requestId}' is already resolved`
          );
        }

        const validOption = reqRecord.options.some((opt) => opt.id === selectedOptionId);
        if (reqRecord.options.length > 0 && !validOption) {
          throw new OrchestrationRejectedError(
            "ERR_INVALID_OPTION_ID",
            `Selected option '${selectedOptionId}' is not valid for request '${requestId}'`
          );
        }

        return {
          streamId: threadId,
          events: [
            {
              streamId: threadId,
              type: "runtime-request.resolved",
              payload: {
                threadId,
                requestId,
                turnId: reqRecord.turnId,
                selectedOptionId,
                messageReply
              },
              createdAt: now
            }
          ],
          outboxEffects: []
        };
      }
    }
  }
}
