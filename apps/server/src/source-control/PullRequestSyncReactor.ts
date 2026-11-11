import { randomUUID } from "node:crypto";
import type { LinkedPullRequest } from "@conductor/contracts";
import type {
  SourceControlDefinitionRegistry,
  SourceControlProviderAdapter
} from "@conductor/source-control-core";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.js";
import type { EventSink } from "../persistence/EventSink.js";

export interface PullRequestSyncReactorOptions {
  readonly environmentId: string;
  readonly sink: EventSink;
  readonly orchestrator: OrchestratorV2;
  readonly definitionRegistry: SourceControlDefinitionRegistry;
}

/**
 * Modeled after t3code's `PullRequestSyncReactor.ts`:
 * Links Pull/Merge Requests from self-hosted intranet forges (GitLab, Forgejo, GHES, Bitbucket DC)
 * to threads, refreshes their state, and automatically dispatches `thread.auto-settle`
 * (`reason: "pr-merged"`) when all linked PRs on an idle thread reach `"merged"` state.
 */
export class PullRequestSyncReactor {
  private readonly environmentId: string;
  private readonly sink: EventSink;
  private readonly orchestrator: OrchestratorV2;
  private readonly definitionRegistry: SourceControlDefinitionRegistry;
  private readonly adaptersByHostId = new Map<string, SourceControlProviderAdapter>();

  constructor(options: PullRequestSyncReactorOptions) {
    this.environmentId = options.environmentId;
    this.sink = options.sink;
    this.orchestrator = options.orchestrator;
    this.definitionRegistry = options.definitionRegistry;
  }

  public registerAdapter(adapter: SourceControlProviderAdapter): void {
    this.adaptersByHostId.set(adapter.hostDefinition.id, adapter);
  }

  public linkPullRequestToThread(threadId: string, pr: LinkedPullRequest): readonly LinkedPullRequest[] {
    const thread = this.sink.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread '${threadId}' not found`);
    }

    const existing = thread.pullRequests.filter(
      (item) => !(item.url === pr.url || (item.repositoryUrl === pr.repositoryUrl && item.number === pr.number))
    );
    const updated = [...existing, pr];
    this.sink.updateThreadPullRequests(threadId, updated);
    return updated;
  }

  public async createAndLinkPullRequest(params: {
    readonly threadId: string;
    readonly remoteUrl: string;
    readonly title: string;
    readonly description?: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  }): Promise<LinkedPullRequest> {
    const detected = this.definitionRegistry.detectForgeForRemoteUrl(params.remoteUrl);
    if (!detected) {
      throw new Error(`No registered intranet forge matches remote URL '${params.remoteUrl}'`);
    }

    const adapter = this.adaptersByHostId.get(detected.definition.id);
    if (!adapter) {
      throw new Error(`No SourceControlProviderAdapter registered for host '${detected.definition.id}'`);
    }

    const created = await adapter.createPullRequest({
      repositorySlug: detected.repositorySlug,
      title: params.title,
      description: params.description,
      headBranch: params.headBranch,
      baseBranch: params.baseBranch
    });

    this.linkPullRequestToThread(params.threadId, created);
    return created;
  }

  public async syncThreadPullRequests(threadId: string): Promise<{
    readonly pullRequests: readonly LinkedPullRequest[];
    readonly autoSettled: boolean;
  }> {
    const thread = this.sink.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread '${threadId}' not found`);
    }

    if (thread.pullRequests.length === 0) {
      return { pullRequests: [], autoSettled: false };
    }

    const refreshed: LinkedPullRequest[] = [];
    for (const pr of thread.pullRequests) {
      const resolved = this.definitionRegistry.resolvePullRequestUrl(pr.url);
      if (!resolved) {
        refreshed.push(pr);
        continue;
      }

      const adapter = this.adaptersByHostId.get(resolved.hostDefinition.id);
      if (!adapter) {
        refreshed.push(pr);
        continue;
      }

      const latest = await adapter.getPullRequestStatus({
        repositorySlug: resolved.repositorySlug,
        number: resolved.number
      });
      refreshed.push(latest);
    }

    this.sink.updateThreadPullRequests(threadId, refreshed);

    const allMerged = refreshed.length > 0 && refreshed.every((pr) => pr.state === "merged");
    const refreshedThread = this.sink.getThread(threadId);
    let autoSettled = false;

    if (
      allMerged &&
      refreshedThread &&
      refreshedThread.status === "idle"
    ) {
      this.orchestrator.dispatch({
        commandId: `cmd_autosettle_${threadId}_${randomUUID().slice(0, 8)}`,
        environmentId: this.environmentId,
        issuedAt: new Date(Date.now() + 10).toISOString(),
        type: "thread.auto-settle",
        payload: {
          threadId,
          reason: "pr-merged",
          settledAt: new Date(Date.now() + 10).toISOString()
        }
      });
      autoSettled = true;
    }

    return {
      pullRequests: refreshed,
      autoSettled
    };
  }
}
