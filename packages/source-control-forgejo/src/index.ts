import type { LinkedPullRequest } from "@conductor/contracts";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";
import type {
  CreatePullRequestInput,
  SourceControlHostDefinition,
  SourceControlProviderAdapter
} from "@conductor/source-control-core";

export interface ForgejoGiteaAdapterOptions {
  readonly hostDefinition: SourceControlHostDefinition;
  readonly accessToken: string;
  readonly networkEvaluator?: NetworkPolicyEvaluator;
}

/**
 * Self-Hosted Forgejo / Gitea REST v1 Adapter (`/api/v1/repos/:owner/:repo/pulls`).
 * Enforces Zero-Internet egress verification via `NetworkPolicyEvaluator` and supports
 * custom corporate Root CA bundles (`caBundlePath`).
 */
export class ForgejoGiteaAdapter implements SourceControlProviderAdapter {
  public readonly hostDefinition: SourceControlHostDefinition;
  private readonly accessToken: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(options: ForgejoGiteaAdapterOptions) {
    this.hostDefinition = options.hostDefinition;
    this.accessToken = options.accessToken;
    this.networkEvaluator =
      options.networkEvaluator ??
      new NetworkPolicyEvaluator({
        caBundlePath: options.hostDefinition.caBundlePath
      });
  }

  private mapState(state: string, merged?: boolean): LinkedPullRequest["state"] {
    if (merged) {
      return "merged";
    }
    if (state === "closed") {
      return "closed";
    }
    return "open";
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<LinkedPullRequest> {
    const url = `${this.hostDefinition.apiBaseUrl}/repos/${input.repositorySlug}/pulls`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `token ${this.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        head: input.headBranch,
        base: input.baseBranch,
        title: input.title,
        body: input.description ?? ""
      })
    });

    if (!res.ok) {
      throw new Error(`Forgejo/Gitea createPullRequest failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      merged?: boolean;
      head?: { ref?: string };
      base?: { ref?: string };
    };

    return {
      forgeKind: "forgejo",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${input.repositorySlug}`,
      number: data.number,
      title: data.title,
      url: data.html_url,
      state: this.mapState(data.state, data.merged),
      headBranch: data.head?.ref ?? input.headBranch,
      baseBranch: data.base?.ref ?? input.baseBranch
    };
  }

  public async getPullRequestStatus(params: {
    readonly repositorySlug: string;
    readonly number: number;
  }): Promise<LinkedPullRequest> {
    const url = `${this.hostDefinition.apiBaseUrl}/repos/${params.repositorySlug}/pulls/${params.number}`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `token ${this.accessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Forgejo/Gitea getPullRequestStatus failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      merged?: boolean;
      head?: { ref?: string };
      base?: { ref?: string };
    };

    return {
      forgeKind: "forgejo",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
      number: data.number,
      title: data.title,
      url: data.html_url,
      state: this.mapState(data.state, data.merged),
      headBranch: data.head?.ref ?? "unknown",
      baseBranch: data.base?.ref ?? "main"
    };
  }

  public async listPullRequestsForBranch(params: {
    readonly repositorySlug: string;
    readonly headBranch: string;
  }): Promise<readonly LinkedPullRequest[]> {
    const url = `${this.hostDefinition.apiBaseUrl}/repos/${params.repositorySlug}/pulls?state=all`;
    await this.networkEvaluator.verifyUrl(url);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `token ${this.accessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Forgejo/Gitea listPullRequestsForBranch failed with HTTP ${res.status}`);
    }

    const items = (await res.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      state: string;
      merged?: boolean;
      head?: { ref?: string };
      base?: { ref?: string };
    }>;

    return items
      .filter((pr) => pr.head?.ref === params.headBranch)
      .map((data) => ({
        forgeKind: "forgejo" as const,
        repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
        number: data.number,
        title: data.title,
        url: data.html_url,
        state: this.mapState(data.state, data.merged),
        headBranch: data.head?.ref ?? params.headBranch,
        baseBranch: data.base?.ref ?? "main"
      }));
  }
}
