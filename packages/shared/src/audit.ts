import { createHash } from "node:crypto";

export interface AuditRecord<TPayload = Record<string, unknown>> {
  readonly index: number;
  readonly timestamp: string;
  readonly category: string;
  readonly action: string;
  readonly payload: TPayload;
  readonly prevHash: string;
  readonly hash: string;
}

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export class TamperEvidentAuditChain<TPayload = Record<string, unknown>> {
  private readonly records: AuditRecord<TPayload>[] = [];
  private readonly maxRecords: number;

  constructor(options: { readonly maxRecords?: number } = {}) {
    this.maxRecords = options.maxRecords ?? 5000;
  }

  public append(
    category: string,
    action: string,
    payload: TPayload,
    timestamp: string = new Date().toISOString()
  ): AuditRecord<TPayload> {
    const lastRecord = this.records[this.records.length - 1];
    const prevHash = lastRecord ? lastRecord.hash : GENESIS_HASH;
    const index = lastRecord ? lastRecord.index + 1 : 1;

    const canonical = JSON.stringify({
      index,
      timestamp,
      category,
      action,
      payload,
      prevHash
    });
    const hash = createHash("sha256").update(canonical).digest("hex");

    const record: AuditRecord<TPayload> = {
      index,
      timestamp,
      category,
      action,
      payload,
      prevHash,
      hash
    };

    if (this.records.length >= this.maxRecords) {
      this.records.shift();
    }
    this.records.push(record);
    return record;
  }

  public getRecords(): readonly AuditRecord<TPayload>[] {
    return [...this.records];
  }

  public clear(): void {
    this.records.length = 0;
  }

  public verifyIntegrity(): boolean {
    for (let i = 0; i < this.records.length; i += 1) {
      const rec = this.records[i]!;
      if (i > 0) {
        const prev = this.records[i - 1]!;
        if (rec.prevHash !== prev.hash) {
          return false;
        }
      }
      const expectedCanonical = JSON.stringify({
        index: rec.index,
        timestamp: rec.timestamp,
        category: rec.category,
        action: rec.action,
        payload: rec.payload,
        prevHash: rec.prevHash
      });
      const expectedHash = createHash("sha256").update(expectedCanonical).digest("hex");
      if (rec.hash !== expectedHash) {
        return false;
      }
    }
    return true;
  }
}
