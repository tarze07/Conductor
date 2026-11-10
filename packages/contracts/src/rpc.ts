import { z } from "zod";
import { OrchestrationEventSchema, ThreadProjectionSchema } from "./orchestration.js";
import { RpcScopeSchema } from "./permissions.js";

export const RpcRequestEnvelopeSchema = z.object({
  frameType: z.literal("rpc.request"),
  requestId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown()
});
export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelopeSchema>;

export const RpcSuccessResponseEnvelopeSchema = z.object({
  frameType: z.literal("rpc.response"),
  requestId: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown()
});

export const RpcErrorResponseEnvelopeSchema = z.object({
  frameType: z.literal("rpc.response"),
  requestId: z.string().min(1),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    requiredScope: RpcScopeSchema.optional(),
    requiredPermission: z.string().optional()
  })
});

export const RpcResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  RpcSuccessResponseEnvelopeSchema,
  RpcErrorResponseEnvelopeSchema
]);
export type RpcResponseEnvelope = z.infer<typeof RpcResponseEnvelopeSchema>;

export const RpcStreamSubscribeSchema = z.object({
  frameType: z.literal("rpc.subscribe"),
  subscriptionId: z.string().min(1),
  streamId: z.string().min(1),
  cursorSeq: z.number().int().nonnegative().default(0)
});
export type RpcStreamSubscribe = z.infer<typeof RpcStreamSubscribeSchema>;

export const RpcStreamEventEnvelopeSchema = z.object({
  frameType: z.literal("rpc.stream.event"),
  subscriptionId: z.string().min(1),
  streamId: z.string().min(1),
  snapshot: ThreadProjectionSchema.optional(),
  events: z.array(OrchestrationEventSchema)
});
export type RpcStreamEventEnvelope = z.infer<typeof RpcStreamEventEnvelopeSchema>;
