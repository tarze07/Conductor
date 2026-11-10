import { z } from "zod";
import { RuntimeModeSchema } from "./permissions.js";

export const LinkedPullRequestSchema = z.object({
  forgeKind: z.enum(["gitlab", "forgejo", "github-enterprise", "bitbucket-dc"]),
  repositoryUrl: z.string().url(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  state: z.enum(["open", "merged", "closed"]),
  headBranch: z.string(),
  baseBranch: z.string()
});
export type LinkedPullRequest = z.infer<typeof LinkedPullRequestSchema>;

const CommandEnvelopeBase = z.object({
  commandId: z.string().min(1),
  environmentId: z.string().min(1),
  issuedAt: z.string().datetime()
});

export const ProjectRegisterCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("project.register"),
  payload: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    rootPath: z.string().min(1),
    defaultBranch: z.string().default("main")
  })
});

export const ThreadCreateCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("thread.create"),
  payload: z.object({
    threadId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    providerInstanceId: z.string().min(1),
    model: z.string().min(1),
    runtimeMode: RuntimeModeSchema,
    worktreeBranch: z.string().optional(),
    linkOrigin: z
      .object({
        sourceEnvironmentId: z.string().min(1),
        modeCeiling: RuntimeModeSchema
      })
      .optional()
  })
});

export const ThreadAutoSettleCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("thread.auto-settle"),
  payload: z.object({
    threadId: z.string().min(1),
    reason: z.enum(["pr-merged", "inactivity", "manual"]),
    settledAt: z.string().datetime()
  })
});

export const TurnStartCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("turn.start"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    prompt: z.string().min(1),
    attachmentIds: z.array(z.string()).default([])
  })
});

export const TurnCancelCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("turn.cancel"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    reason: z.string().optional()
  })
});

export const TurnFinalizeCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("turn.finalize"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum(["completed", "cancelled", "failed", "usage_limit"]),
    checkpointRef: z.string().optional(),
    diffSummary: z
      .object({
        filesChanged: z.number().int().nonnegative(),
        insertions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative()
      })
      .optional(),
    errorMessage: z.string().optional()
  })
});

export const CheckpointRestoreCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("checkpoint.restore"),
  payload: z.object({
    threadId: z.string().min(1),
    targetTurnId: z.string().min(1),
    checkpointRef: z.string().min(1)
  })
});

export const RuntimeRequestRespondCommandSchema = CommandEnvelopeBase.extend({
  type: z.literal("runtime-request.respond"),
  payload: z.object({
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    selectedOptionId: z.string().min(1),
    messageReply: z.string().optional()
  })
});

export const OrchestrationCommandSchema = z.discriminatedUnion("type", [
  ProjectRegisterCommandSchema,
  ThreadCreateCommandSchema,
  ThreadAutoSettleCommandSchema,
  TurnStartCommandSchema,
  TurnCancelCommandSchema,
  TurnFinalizeCommandSchema,
  CheckpointRestoreCommandSchema,
  RuntimeRequestRespondCommandSchema
]);
export type OrchestrationCommand = z.infer<typeof OrchestrationCommandSchema>;

export const OrchestrationEventTypeSchema = z.enum([
  "project.registered",
  "thread.created",
  "thread.settled",
  "turn.started",
  "message.delta",
  "tool.call.started",
  "tool.call.completed",
  "runtime-request.opened",
  "runtime-request.resolved",
  "checkpoint.captured",
  "checkpoint.restored",
  "turn.completed",
  "turn.failed"
]);
export type OrchestrationEventType = z.infer<typeof OrchestrationEventTypeSchema>;

export const OrchestrationEventSchema = z.object({
  seq: z.number().int().positive(),
  streamId: z.string().min(1),
  streamVersion: z.number().int().positive(),
  type: OrchestrationEventTypeSchema,
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime()
});
export type OrchestrationEvent = z.infer<typeof OrchestrationEventSchema>;

export const CommandReceiptSchema = z.object({
  commandId: z.string().min(1),
  streamId: z.string().min(1),
  resultSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const OutboxEffectSchema = z.object({
  effectId: z.string().min(1),
  type: z.enum([
    "provider.run_turn",
    "provider.cancel_turn",
    "checkpoint.capture",
    "checkpoint.restore",
    "source_control.sync_prs"
  ]),
  streamId: z.string().min(1),
  payload: z.record(z.unknown()),
  status: z.enum(["pending", "running", "completed", "retired"]),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});
export type OutboxEffect = z.infer<typeof OutboxEffectSchema>;

export const ThreadProjectionSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  providerInstanceId: z.string().min(1),
  model: z.string().min(1),
  runtimeMode: RuntimeModeSchema,
  status: z.enum(["idle", "running", "awaiting_input", "settled", "failed"]),
  lastEventSeq: z.number().int().nonnegative(),
  prunedThroughSeq: z.number().int().nonnegative().default(0),
  pullRequests: z.array(LinkedPullRequestSchema).default([]),
  updatedAt: z.string().datetime()
});
export type ThreadProjection = z.infer<typeof ThreadProjectionSchema>;
