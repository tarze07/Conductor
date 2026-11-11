import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";

export interface EncryptedSecretEnvelope {
  readonly algorithm: "aes-256-gcm";
  readonly kdf: "scrypt";
  readonly saltHex: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
  readonly updatedAt: string;
}

export interface LocalEncryptedSecretStoreOptions {
  readonly masterKeyOrPassphrase: string;
  readonly storageFilePath?: string;
}

/**
 * AES-256-GCM encrypted local secret store with scrypt key derivation.
 * Protects GitLab/Forgejo Personal Access Tokens, internal LLM keys, and Vault tokens at rest.
 */
export class LocalEncryptedSecretStore {
  private readonly masterSecret: string;
  private readonly storageFilePath?: string;
  private readonly records = new Map<string, EncryptedSecretEnvelope>();

  constructor(options: LocalEncryptedSecretStoreOptions) {
    if (!options.masterKeyOrPassphrase) {
      throw new Error("LocalEncryptedSecretStore requires a non-empty masterKeyOrPassphrase");
    }
    this.masterSecret = options.masterKeyOrPassphrase;
    this.storageFilePath = options.storageFilePath;

    if (this.storageFilePath && existsSync(this.storageFilePath)) {
      const raw = JSON.parse(readFileSync(this.storageFilePath, "utf8")) as Record<
        string,
        EncryptedSecretEnvelope
      >;
      for (const [k, v] of Object.entries(raw)) {
        this.records.set(k, v);
      }
    }
  }

  public setSecret(key: string, plaintext: string): EncryptedSecretEnvelope {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const derivedKey = scryptSync(this.masterSecret, salt, 32);

    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const envelope: EncryptedSecretEnvelope = {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      saltHex: salt.toString("hex"),
      ivHex: iv.toString("hex"),
      authTagHex: authTag.toString("hex"),
      ciphertextHex: encrypted.toString("hex"),
      updatedAt: new Date().toISOString()
    };

    this.records.set(key, envelope);
    this.flushToDisk();
    return envelope;
  }

  public getSecret(key: string): string | undefined {
    const envelope = this.records.get(key);
    if (!envelope) {
      return undefined;
    }

    const salt = Buffer.from(envelope.saltHex, "hex");
    const iv = Buffer.from(envelope.ivHex, "hex");
    const authTag = Buffer.from(envelope.authTagHex, "hex");
    const ciphertext = Buffer.from(envelope.ciphertextHex, "hex");
    const derivedKey = scryptSync(this.masterSecret, salt, 32);

    const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  }

  public deleteSecret(key: string): boolean {
    const existed = this.records.delete(key);
    if (existed) {
      this.flushToDisk();
    }
    return existed;
  }

  public listSecretKeys(): readonly string[] {
    return [...this.records.keys()];
  }

  public getEncryptedEnvelope(key: string): EncryptedSecretEnvelope | undefined {
    return this.records.get(key);
  }

  private flushToDisk(): void {
    if (!this.storageFilePath) {
      return;
    }
    mkdirSync(dirname(this.storageFilePath), { recursive: true });
    const obj: Record<string, EncryptedSecretEnvelope> = {};
    for (const [k, v] of this.records.entries()) {
      obj[k] = v;
    }
    writeFileSync(this.storageFilePath, JSON.stringify(obj, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}

export interface HashiCorpVaultConnectorOptions {
  readonly vaultBaseUrl: string;
  readonly vaultToken: string;
  readonly kvMount?: string;
  readonly namespace?: string;
  readonly caBundlePath?: string;
  readonly networkEvaluator?: NetworkPolicyEvaluator;
}

/**
 * Connector for on-premise HashiCorp Vault KV v2 secrets engine (`/v1/<mount>/data/<path>`).
 * Strictly gated by `NetworkPolicyEvaluator` so Vault requests never leave the corporate intranet.
 */
export class HashiCorpVaultConnector {
  private readonly baseUrl: string;
  private readonly vaultToken: string;
  private readonly kvMount: string;
  private readonly namespace?: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(options: HashiCorpVaultConnectorOptions) {
    this.baseUrl = options.vaultBaseUrl.replace(/\/+$/, "");
    this.vaultToken = options.vaultToken;
    this.kvMount = options.kvMount ?? "secret";
    this.namespace = options.namespace;
    this.networkEvaluator =
      options.networkEvaluator ??
      new NetworkPolicyEvaluator({
        caBundlePath: options.caBundlePath
      });
  }

  public async readKvV2Secret(secretPath: string): Promise<Readonly<Record<string, unknown>>> {
    const cleanPath = secretPath.replace(/^\/+/, "");
    const url = `${this.baseUrl}/v1/${this.kvMount}/data/${cleanPath}`;
    await this.networkEvaluator.verifyUrl(url);

    const headers: Record<string, string> = {
      "x-vault-token": this.vaultToken
    };
    if (this.namespace) {
      headers["x-vault-namespace"] = this.namespace;
    }

    const res = await fetch(url, {
      method: "GET",
      headers
    });

    if (!res.ok) {
      throw new Error(`HashiCorp Vault KV v2 read failed with HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      data?: {
        data?: Record<string, unknown>;
      };
    };

    return body.data?.data ?? {};
  }
}
