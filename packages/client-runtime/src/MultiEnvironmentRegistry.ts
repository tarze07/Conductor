import type { EnvironmentRoute, ThreadProjection } from "@conductor/contracts";
import { EnvironmentClient } from "./EnvironmentClient.js";

export interface ScopedEnvironmentRegistration {
  readonly environmentId: string;
  readonly label: string;
  readonly routes: readonly EnvironmentRoute[];
}

export interface ScopedThreadReference {
  readonly environmentId: string;
  readonly thread: ThreadProjection;
}

/**
 * Manages connections to multiple Conductor environments (`environmentId`),
 * scoping projects, threads, and RPC calls per environment (modeled after t3code's `remote.md`).
 */
export class MultiEnvironmentRegistry {
  private readonly clients = new Map<string, EnvironmentClient>();
  private readonly registrations = new Map<string, ScopedEnvironmentRegistration>();

  public registerEnvironment(registration: ScopedEnvironmentRegistration): EnvironmentClient {
    const client = new EnvironmentClient({
      expectedEnvironmentId: registration.environmentId,
      label: registration.label,
      routes: registration.routes
    });
    this.registrations.set(registration.environmentId, registration);
    this.clients.set(registration.environmentId, client);
    return client;
  }

  public getClient(environmentId: string): EnvironmentClient | undefined {
    return this.clients.get(environmentId);
  }

  public listRegistrations(): readonly ScopedEnvironmentRegistration[] {
    return [...this.registrations.values()];
  }

  public async listThreadsAcrossEnvironments(): Promise<readonly ScopedThreadReference[]> {
    const results: ScopedThreadReference[] = [];
    for (const [environmentId, client] of this.clients.entries()) {
      const threads = await client.call<readonly ThreadProjection[]>("thread.list", {});
      for (const thread of threads) {
        results.push({ environmentId, thread });
      }
    }
    return results;
  }

  public async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}
