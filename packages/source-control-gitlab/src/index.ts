import type { LinkedPullRequest } from "@conductor/contracts";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";
import type {
  CreatePullRequestInput,
  SourceControlHostDefinition,
  SourceControlProviderAdapter
} from "@conductor/source-control-core";

export interface GitLabSelfManagedAdapterOptions {
  readonly hostDefinition: SourceControlHostDefinition;
  readonly privateToken: string;
  readonly networkEvaluator?: NetworkPolicyEvaluator;
}

/**
 * Self-Managed GitLab REST v4 Adapter (`/api/v4/projects/:id/merge_requests`).
 * Enforces Zero-Internet egress verification via `NetworkPolicyEvaluator` and supports
 * custom corporate Root CA bundles (`caBundlePath`).
 */
export class GitLabSelfManagedAdapter implements SourceControlProviderAdapter {
  public readonly hostDefinition: SourceControlHostDefinition;
  private readonly privateToken: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(options: GitLabSelfManagedAdapterOptions) {
    this.hostDefinition = options.hostDefinition;
    this.privateToken = options.privateToken;
    this.networkEvaluator =
      options.networkEvaluator ??
      new NetworkPolicyEvaluator({
        caBundlePath: options.hostDefinition.caBundlePath
      });
  }

  private mapGitLabState(rawState: string): LinkedPullRequest["state"] {
    if (rawState === "merged") {
      return "merged";
    }
    if (rawState === "closed") {
      return "closed";
    }
    return "open";
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<LinkedPullRequest> {
    const encodedProject = encodeURIComponent(input.repositorySlug);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${encodedProject}/merge_requests`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "private-token": this.privateToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.description ?? ""
      })
    });

    if (!res.ok) {
      throw new Error(`GitLab createMergeRequest failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      iid: number;
      title: string;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    };

    return {
      forgeKind: "gitlab",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${input.repositorySlug}`,
      number: data.iid,
      title: data.title,
      url: data.web_url,
      state: this.mapGitLabState(data.state),
      headBranch: data.source_branch,
      baseBranch: data.target_branch
    };
  }

  public async getPullRequestStatus(params: {
    readonly repositorySlug: string;
    readonly number: number;
  }): Promise<LinkedPullRequest> {
    const encodedProject = encodeURIComponent(params.repositorySlug);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${encodedProject}/merge_requests/${params.number}`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "private-token": this.privateToken
      }
    });

    if (!res.ok) {
      throw new Error(`GitLab getMergeRequestStatus failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      iid: number;
      title: string;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    };

    return {
      forgeKind: "gitlab",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
      number: data.iid,
      title: data.title,
      url: data.web_url,
      state: this.mapGitLabState(data.state),
      headBranch: data.source_branch,
      baseBranch: data.target_branch
    };
  }

  public async listPullRequestsForBranch(params: {
    readonly repositorySlug: string;
    readonly headBranch: string;
  }): Promise<readonly LinkedPullRequest[]> {
    const encodedProject = encodeURIComponent(params.repositorySlug);
    const encodedBranch = encodeURIComponent(params.headBranch);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${encodedProject}/merge_requests?source_branch=${encodedBranch}`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "private-token": this.privateToken
      }
    });

    if (!res.ok) {
      throw new Error(`GitLab listMergeRequestsForBranch failed with HTTP ${res.status}`);
    }

    const items = (await res.json()) as Array<{
      iid: number;
      title: string;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    }>;

    return items.map((data) => ({
      forgeKind: "gitlab" as const,
      repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
      number: data.iid,
      title: data.title,
      url: data.web_url,
      state: this.mapGitLabState(data.state),
      headBranch: data.source_branch,
      baseBranch: data.target_branch
    }));
  }
}
