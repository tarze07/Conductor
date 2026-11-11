import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  TamperEvidentAuditChain,
  verifyAuditRecordsChain,
  type AuditRecord
} from "@conductor/shared";

export type EnterpriseAuditCategory =
  | "agent.prompt"
  | "agent.file_edit"
  | "agent.terminal_command"
  | "agent.approval"
  | "network.egress_blocked"
  | "auth.session"
  | "peer_link.delegation";

export interface EnterpriseAuditEventPayload {
  readonly actor: string;
  readonly environmentId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Append-only JSONL AuditLogger with SHA-256 hash chaining (`prevHash` -> `hash`),
 * designed for enterprise air-gapped compliance and SIEM export.
 */
export class AuditLogger {
  private readonly chain = new TamperEvidentAuditChain<EnterpriseAuditEventPayload>();
  private readonly jsonlFilePath?: string;

  constructor(options: { readonly jsonlFilePath?: string } = {}) {
    this.jsonlFilePath = options.jsonlFilePath;
    if (this.jsonlFilePath) {
      mkdirSync(dirname(this.jsonlFilePath), { recursive: true });
    }
  }

  public logEvent(
    category: EnterpriseAuditCategory,
    payload: EnterpriseAuditEventPayload
  ): AuditRecord<EnterpriseAuditEventPayload> {
    const record = this.chain.append(payload.actor, category, payload);
    if (this.jsonlFilePath) {
      appendFileSync(this.jsonlFilePath, `${JSON.stringify(record)}\n`, "utf8");
    }
    return record;
  }

  public getRecords(): readonly AuditRecord<EnterpriseAuditEventPayload>[] {
    return this.chain.getRecords();
  }

  public verifyIntegrity(): boolean {
    if (this.jsonlFilePath && existsSync(this.jsonlFilePath)) {
      const lines = readFileSync(this.jsonlFilePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const parsed = lines.map(
        (l) => JSON.parse(l) as AuditRecord<EnterpriseAuditEventPayload>
      );
      return verifyAuditRecordsChain(parsed);
    }
    return this.chain.verifyIntegrity();
  }
}
