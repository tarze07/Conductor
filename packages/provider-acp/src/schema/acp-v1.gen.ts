// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY.
// Generated offline from schema/acp-schema-v1.json (https://agentclientprotocol.com/schemas/v1/acp-schema-v1.json)
// Run `pnpm --filter @conductor/provider-acp schema:generate` to regenerate.

import { z } from "zod";

export const ACP_LATEST_PROTOCOL_VERSION = 1 as const;

export const AcpProtocolVersionSchema = z.number().int().min(1);
export type AcpProtocolVersion = z.infer<typeof AcpProtocolVersionSchema>;

export const AcpImplementationSchema = z.object({
  name: z.string(),
  title: z.string().nullable().optional(),
  version: z.string()
});
export type AcpImplementation = z.infer<typeof AcpImplementationSchema>;

export const AcpClientCapabilitiesSchema = z.object({
  fs: z
    .object({
      readTextFile: z.boolean().optional(),
      writeTextFile: z.boolean().optional()
    })
    .optional(),
  terminal: z.boolean().optional()
});
export type AcpClientCapabilities = z.infer<typeof AcpClientCapabilitiesSchema>;

export const AcpAgentCapabilitiesSchema = z.object({
  loadSession: z.boolean().optional(),
  promptCapabilities: z
    .object({
      image: z.boolean().optional(),
      audio: z.boolean().optional(),
      embeddedContext: z.boolean().optional()
    })
    .optional(),
  mcpCapabilities: z
    .object({
      http: z.boolean().optional(),
      sse: z.boolean().optional()
    })
    .optional()
});
export type AcpAgentCapabilities = z.infer<typeof AcpAgentCapabilitiesSchema>;

export const AcpAuthMethodSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional()
});
export type AcpAuthMethod = z.infer<typeof AcpAuthMethodSchema>;

export const AcpInitializeRequestSchema = z.object({
  protocolVersion: AcpProtocolVersionSchema,
  clientCapabilities: AcpClientCapabilitiesSchema.optional(),
  clientInfo: AcpImplementationSchema.optional()
});
export type AcpInitializeRequest = z.infer<typeof AcpInitializeRequestSchema>;

export const AcpInitializeResponseSchema = z.object({
  protocolVersion: AcpProtocolVersionSchema,
  agentCapabilities: AcpAgentCapabilitiesSchema.optional(),
  authMethods: z.array(AcpAuthMethodSchema).optional(),
  agentInfo: AcpImplementationSchema.optional()
});
export type AcpInitializeResponse = z.infer<typeof AcpInitializeResponseSchema>;

export const AcpAuthenticateRequestSchema = z.object({
  methodId: z.string().min(1)
});
export type AcpAuthenticateRequest = z.infer<typeof AcpAuthenticateRequestSchema>;

export const AcpAuthenticateResponseSchema = z.object({}).passthrough();
export type AcpAuthenticateResponse = z.infer<typeof AcpAuthenticateResponseSchema>;

export const AcpKeyValuePairSchema = z.object({
  name: z.string(),
  value: z.string()
});
export type AcpKeyValuePair = z.infer<typeof AcpKeyValuePairSchema>;

export const AcpMcpServerStdioSchema = z.object({
  type: z.literal("stdio").optional(),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.array(AcpKeyValuePairSchema).optional()
});
export type AcpMcpServerStdio = z.infer<typeof AcpMcpServerStdioSchema>;

export const AcpMcpServerHttpSchema = z.object({
  type: z.enum(["http", "sse"]),
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.array(AcpKeyValuePairSchema)
});
export type AcpMcpServerHttp = z.infer<typeof AcpMcpServerHttpSchema>;

export const AcpMcpServerSchema = z.union([AcpMcpServerHttpSchema, AcpMcpServerStdioSchema]);
export type AcpMcpServer = z.infer<typeof AcpMcpServerSchema>;

export const AcpSessionModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional()
});
export type AcpSessionMode = z.infer<typeof AcpSessionModeSchema>;

export const AcpSessionModeStateSchema = z.object({
  currentModeId: z.string().min(1),
  availableModes: z.array(AcpSessionModeSchema)
});
export type AcpSessionModeState = z.infer<typeof AcpSessionModeStateSchema>;

export const AcpNewSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  mcpServers: z.array(AcpMcpServerSchema)
});
export type AcpNewSessionRequest = z.infer<typeof AcpNewSessionRequestSchema>;

export const AcpNewSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  modes: AcpSessionModeStateSchema.nullable().optional()
});
export type AcpNewSessionResponse = z.infer<typeof AcpNewSessionResponseSchema>;

export const AcpLoadSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  mcpServers: z.array(AcpMcpServerSchema)
});
export type AcpLoadSessionRequest = z.infer<typeof AcpLoadSessionRequestSchema>;

export const AcpLoadSessionResponseSchema = z.object({
  modes: AcpSessionModeStateSchema.nullable().optional()
});
export type AcpLoadSessionResponse = z.infer<typeof AcpLoadSessionResponseSchema>;

export const AcpSetSessionModeRequestSchema = z.object({
  sessionId: z.string().min(1),
  modeId: z.string().min(1)
});
export type AcpSetSessionModeRequest = z.infer<typeof AcpSetSessionModeRequestSchema>;

export const AcpSetSessionModeResponseSchema = z.object({}).passthrough();
export type AcpSetSessionModeResponse = z.infer<typeof AcpSetSessionModeResponseSchema>;

export const AcpTextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});
export type AcpTextContentBlock = z.infer<typeof AcpTextContentBlockSchema>;

export const AcpResourceLinkContentBlockSchema = z.object({
  type: z.literal("resource_link"),
  uri: z.string(),
  name: z.string(),
  mimeType: z.string().nullable().optional()
});
export type AcpResourceLinkContentBlock = z.infer<typeof AcpResourceLinkContentBlockSchema>;

export const AcpEmbeddedResourceContentBlockSchema = z.object({
  type: z.literal("resource"),
  resource: z.object({
    uri: z.string(),
    text: z.string(),
    mimeType: z.string().nullable().optional()
  })
});
export type AcpEmbeddedResourceContentBlock = z.infer<typeof AcpEmbeddedResourceContentBlockSchema>;

export const AcpContentBlockSchema = z.discriminatedUnion("type", [
  AcpTextContentBlockSchema,
  AcpResourceLinkContentBlockSchema,
  AcpEmbeddedResourceContentBlockSchema
]);
export type AcpContentBlock = z.infer<typeof AcpContentBlockSchema>;

export const AcpStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled"
]);
export type AcpStopReason = z.infer<typeof AcpStopReasonSchema>;

export const AcpPromptRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.array(AcpContentBlockSchema).min(1)
});
export type AcpPromptRequest = z.infer<typeof AcpPromptRequestSchema>;

export const AcpPromptResponseSchema = z.object({
  stopReason: AcpStopReasonSchema
});
export type AcpPromptResponse = z.infer<typeof AcpPromptResponseSchema>;

export const AcpCancelNotificationSchema = z.object({
  sessionId: z.string().min(1)
});
export type AcpCancelNotification = z.infer<typeof AcpCancelNotificationSchema>;

export const AcpToolCallKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other"
]);
export type AcpToolCallKind = z.infer<typeof AcpToolCallKindSchema>;

export const AcpToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type AcpToolCallStatus = z.infer<typeof AcpToolCallStatusSchema>;

export const AcpPlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"])
});
export type AcpPlanEntry = z.infer<typeof AcpPlanEntrySchema>;

export const AcpSessionUpdatePayloadSchema = z
  .object({
    sessionUpdate: z.string()
  })
  .passthrough();
export type AcpSessionUpdatePayload = z.infer<typeof AcpSessionUpdatePayloadSchema>;

export const AcpSessionNotificationSchema = z.object({
  sessionId: z.string().min(1),
  update: AcpSessionUpdatePayloadSchema
});
export type AcpSessionNotification = z.infer<typeof AcpSessionNotificationSchema>;

export const AcpPermissionOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always"
]);
export type AcpPermissionOptionKind = z.infer<typeof AcpPermissionOptionKindSchema>;

export const AcpPermissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: AcpPermissionOptionKindSchema
});
export type AcpPermissionOption = z.infer<typeof AcpPermissionOptionSchema>;

export const AcpRequestPermissionRequestSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z.object({
    toolCallId: z.string().min(1),
    title: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional()
  }),
  options: z.array(AcpPermissionOptionSchema).min(1)
});
export type AcpRequestPermissionRequest = z.infer<typeof AcpRequestPermissionRequestSchema>;

export const AcpRequestPermissionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("cancelled")
  }),
  z.object({
    outcome: z.literal("selected"),
    optionId: z.string().min(1)
  })
]);
export type AcpRequestPermissionOutcome = z.infer<typeof AcpRequestPermissionOutcomeSchema>;

export const AcpRequestPermissionResponseSchema = z.object({
  outcome: AcpRequestPermissionOutcomeSchema
});
export type AcpRequestPermissionResponse = z.infer<typeof AcpRequestPermissionResponseSchema>;

export const AcpReadTextFileRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().min(1).nullable().optional(),
  limit: z.number().int().min(1).nullable().optional()
});
export type AcpReadTextFileRequest = z.infer<typeof AcpReadTextFileRequestSchema>;

export const AcpReadTextFileResponseSchema = z.object({
  content: z.string()
});
export type AcpReadTextFileResponse = z.infer<typeof AcpReadTextFileResponseSchema>;

export const AcpWriteTextFileRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  content: z.string()
});
export type AcpWriteTextFileRequest = z.infer<typeof AcpWriteTextFileRequestSchema>;

export const AcpWriteTextFileResponseSchema = z.object({}).passthrough();
export type AcpWriteTextFileResponse = z.infer<typeof AcpWriteTextFileResponseSchema>;

export const JsonRpcIdSchema = z.union([z.number().int(), z.string()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional()
});

export const JsonRpcNotificationEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional()
});

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional()
});

export const JsonRpcResponseEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.nullable(),
  result: z.unknown().optional(),
  error: JsonRpcErrorObjectSchema.optional()
});
