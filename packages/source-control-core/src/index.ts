import type { LinkedPullRequest } from "@conductor/contracts";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";

export type ForgeKind = LinkedPullRequest["forgeKind"];

export interface SourceControlHostConfig {
  readonly id: string;
  readonly kind: ForgeKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiBaseUrl?: string;
  readonly caBundlePath?: string;
}

export interface ParsedPullRequestUrl {
  readonly hostDefinition: SourceControlHostDefinition;
  readonly repositorySlug: string;
  readonly number: number;
}

export interface SourceControlHostDefinition {
  readonly id: string;
  readonly kind: ForgeKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly hostname: string;
  readonly caBundlePath?: string;
  matchesRemoteUrl(remoteUrl: string): boolean;
  parseRepositorySlug(remoteUrl: string): string | undefined;
  parsePullRequestUrl(prUrl: string): { readonly repositorySlug: string; readonly number: number } | undefined;
}

export interface CreatePullRequestInput {
  readonly repositorySlug: string;
  readonly title: string;
  readonly description?: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface SourceControlProviderAdapter {
  readonly hostDefinition: SourceControlHostDefinition;
  createPullRequest(input: CreatePullRequestInput): Promise<LinkedPullRequest>;
  getPullRequestStatus(params: {
    readonly repositorySlug: string;
    readonly number: number;
  }): Promise<LinkedPullRequest>;
  listPullRequestsForBranch(params: {
    readonly repositorySlug: string;
    readonly headBranch: string;
  }): Promise<readonly LinkedPullRequest[]>;
}

function extractHostAndPathFromRemote(remoteUrl: string): {
  readonly hostname: string;
  readonly path: string;
} | undefined {
  const trimmed = remoteUrl.trim();
  // Match SCP-style SSH URLs: git@gitlab.corp.internal:group/project.git
  const scpMatch = /^(?:[^@]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes("://")) {
    return {
      hostname: scpMatch[1]!.toLowerCase(),
      path: scpMatch[2]!.replace(/^\/+/, "").replace(/\.git$/i, "")
    };
  }

  try {
    const parsed = new URL(trimmed);
    return {
      hostname: parsed.hostname.toLowerCase(),
      path: parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "")
    };
  } catch {
    return undefined;
  }
}

export function createSourceControlHostDefinition(
  config: SourceControlHostConfig
): SourceControlHostDefinition {
  const normalizedBase = config.baseUrl.replace(/\/+$/, "");
  const parsedBase = new URL(normalizedBase);
  const hostname = parsedBase.hostname.toLowerCase();

  const defaultApiBase =
    config.kind === "gitlab"
      ? `${normalizedBase}/api/v4`
      : config.kind === "forgejo"
        ? `${normalizedBase}/api/v1`
        : config.kind === "github-enterprise"
          ? `${normalizedBase}/api/v3`
          : `${normalizedBase}/rest/api/1.0`;

  return {
    id: config.id,
    kind: config.kind,
    label: config.label,
    baseUrl: normalizedBase,
    apiBaseUrl: (config.apiBaseUrl ?? defaultApiBase).replace(/\/+$/, ""),
    hostname,
    caBundlePath: config.caBundlePath,
    matchesRemoteUrl(remoteUrl: string): boolean {
      const info = extractHostAndPathFromRemote(remoteUrl);
      return info?.hostname === hostname;
    },
    parseRepositorySlug(remoteUrl: string): string | undefined {
      const info = extractHostAndPathFromRemote(remoteUrl);
      if (!info || info.hostname !== hostname || !info.path) {
        return undefined;
      }
      // Strip Bitbucket Data Center /scm/ prefix if present
      if (config.kind === "bitbucket-dc" && info.path.startsWith("scm/")) {
        return info.path.slice("scm/".length);
      }
      return info.path;
    },
    parsePullRequestUrl(
      prUrl: string
    ): { readonly repositorySlug: string; readonly number: number } | undefined {
      let parsed: URL;
      try {
        parsed = new URL(prUrl);
      } catch {
        return undefined;
      }
      if (parsed.hostname.toLowerCase() !== hostname) {
        return undefined;
      }
      const pathname = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

      // GitLab Self-Managed: <group>/<project>/-/merge_requests/<iid>
      const glMatch = /^(.+?)\/-\/merge_requests\/(\d+)$/.exec(pathname);
      if (glMatch) {
        return {
          repositorySlug: glMatch[1]!,
          number: Number.parseInt(glMatch[2]!, 10)
        };
      }

      // Forgejo / Gitea / GitHub Enterprise: <owner>/<repo>/pulls/<num> or <owner>/<repo>/pull/<num>
      const ghOrFgMatch = /^([^/]+\/[^/]+)\/pulls?\/(\d+)$/.exec(pathname);
      if (ghOrFgMatch) {
        return {
          repositorySlug: ghOrFgMatch[1]!,
          number: Number.parseInt(ghOrFgMatch[2]!, 10)
        };
      }

      // Bitbucket Data Center: projects/<PROJ>/repos/<repo>/pull-requests/<id>
      const bbMatch = /^projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)$/.exec(pathname);
      if (bbMatch) {
        return {
          repositorySlug: `${bbMatch[1]!}/${bbMatch[2]!}`,
          number: Number.parseInt(bbMatch[3]!, 10)
        };
      }

      return undefined;
    }
  };
}

export interface SourceControlDefinitionRegistry {
  readonly definitions: readonly SourceControlHostDefinition[];
  getById(id: string): SourceControlHostDefinition | undefined;
  detectForgeForRemoteUrl(remoteUrl: string):
    | {
        readonly definition: SourceControlHostDefinition;
        readonly repositorySlug: string;
      }
    | undefined;
  resolvePullRequestUrl(prUrl: string): ParsedPullRequestUrl | undefined;
}

/**
 * Modeled after `@t3tools/source-control-definitions` (`makeSourceControlDefinitionRegistry`):
 * Registers self-hosted intranet Git forges and resolves repository remotes and PR/MR links.
 */
export function makeSourceControlDefinitionRegistry(
  configs: readonly SourceControlHostConfig[]
): SourceControlDefinitionRegistry {
  const definitions = configs.map((c) => createSourceControlHostDefinition(c));
  const byId = new Map(definitions.map((d) => [d.id, d]));

  return {
    definitions,
    getById(id: string) {
      return byId.get(id);
    },
    detectForgeForRemoteUrl(remoteUrl: string) {
      for (const def of definitions) {
        if (def.matchesRemoteUrl(remoteUrl)) {
          const slug = def.parseRepositorySlug(remoteUrl);
          if (slug) {
            return { definition: def, repositorySlug: slug };
          }
        }
      }
      return undefined;
    },
    resolvePullRequestUrl(prUrl: string) {
      for (const def of definitions) {
        const parsed = def.parsePullRequestUrl(prUrl);
        if (parsed) {
          return {
            hostDefinition: def,
            repositorySlug: parsed.repositorySlug,
            number: parsed.number
          };
        }
      }
      return undefined;
    }
  };
}

/**
 * On-Premise GitHub Enterprise Server (GHES) Adapter (`/api/v3/repos/:owner/:repo/pulls`).
 */
export class GitHubEnterpriseAdapter implements SourceControlProviderAdapter {
  public readonly hostDefinition: SourceControlHostDefinition;
  private readonly token: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(params: {
    readonly hostDefinition: SourceControlHostDefinition;
    readonly token: string;
    readonly networkEvaluator?: NetworkPolicyEvaluator;
  }) {
    this.hostDefinition = params.hostDefinition;
    this.token = params.token;
    this.networkEvaluator =
      params.networkEvaluator ??
      new NetworkPolicyEvaluator({ caBundlePath: params.hostDefinition.caBundlePath });
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<LinkedPullRequest> {
    const url = `${this.hostDefinition.apiBaseUrl}/repos/${input.repositorySlug}/pulls`;
    await this.networkEvaluator.verifyUrl(url);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: input.title,
        body: input.description ?? "",
        head: input.headBranch,
        base: input.baseBranch
      })
    });
    if (!res.ok) {
      throw new Error(`GHES createPullRequest failed with HTTP ${res.status}`);
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
      forgeKind: "github-enterprise",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${input.repositorySlug}`,
      number: data.number,
      title: data.title,
      url: data.html_url,
      state: data.merged ? "merged" : data.state === "closed" ? "closed" : "open",
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
      headers: { authorization: `Bearer ${this.token}` }
    });
    if (!res.ok) {
      throw new Error(`GHES getPullRequestStatus failed with HTTP ${res.status}`);
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
      forgeKind: "github-enterprise",
      repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
      number: data.number,
      title: data.title,
      url: data.html_url,
      state: data.merged ? "merged" : data.state === "closed" ? "closed" : "open",
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
      headers: { authorization: `Bearer ${this.token}` }
    });
    if (!res.ok) {
      throw new Error(`GHES listPullRequestsForBranch failed with HTTP ${res.status}`);
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
        forgeKind: "github-enterprise" as const,
        repositoryUrl: `${this.hostDefinition.baseUrl}/${params.repositorySlug}`,
        number: data.number,
        title: data.title,
        url: data.html_url,
        state: data.merged ? ("merged" as const) : data.state === "closed" ? ("closed" as const) : ("open" as const),
        headBranch: data.head?.ref ?? params.headBranch,
        baseBranch: data.base?.ref ?? "main"
      }));
  }
}

/**
 * On-Premise Bitbucket Data Center Adapter (`/rest/api/1.0/projects/:proj/repos/:repo/pull-requests`).
 */
export class BitbucketDataCenterAdapter implements SourceControlProviderAdapter {
  public readonly hostDefinition: SourceControlHostDefinition;
  private readonly token: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(params: {
    readonly hostDefinition: SourceControlHostDefinition;
    readonly token: string;
    readonly networkEvaluator?: NetworkPolicyEvaluator;
  }) {
    this.hostDefinition = params.hostDefinition;
    this.token = params.token;
    this.networkEvaluator =
      params.networkEvaluator ??
      new NetworkPolicyEvaluator({ caBundlePath: params.hostDefinition.caBundlePath });
  }

  private splitProjectAndRepo(slug: string): { readonly projectKey: string; readonly repoSlug: string } {
    const parts = slug.split("/");
    return {
      projectKey: parts[0] ?? "PROJ",
      repoSlug: parts[1] ?? "repo"
    };
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<LinkedPullRequest> {
    const { projectKey, repoSlug } = this.splitProjectAndRepo(input.repositorySlug);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests`;
    await this.networkEvaluator.verifyUrl(url);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: input.title,
        description: input.description ?? "",
        fromRef: { id: `refs/heads/${input.headBranch}` },
        toRef: { id: `refs/heads/${input.baseBranch}` }
      })
    });
    if (!res.ok) {
      throw new Error(`Bitbucket DC createPullRequest failed with HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      id: number;
      title: string;
      state: string;
    };
    return {
      forgeKind: "bitbucket-dc",
      repositoryUrl: `${this.hostDefinition.baseUrl}/scm/${projectKey}/${repoSlug}`,
      number: data.id,
      title: data.title,
      url: `${this.hostDefinition.baseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests/${data.id}`,
      state: data.state === "MERGED" ? "merged" : data.state === "DECLINED" ? "closed" : "open",
      headBranch: input.headBranch,
      baseBranch: input.baseBranch
    };
  }

  public async getPullRequestStatus(params: {
    readonly repositorySlug: string;
    readonly number: number;
  }): Promise<LinkedPullRequest> {
    const { projectKey, repoSlug } = this.splitProjectAndRepo(params.repositorySlug);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests/${params.number}`;
    await this.networkEvaluator.verifyUrl(url);
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` }
    });
    if (!res.ok) {
      throw new Error(`Bitbucket DC getPullRequestStatus failed with HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      id: number;
      title: string;
      state: string;
      fromRef?: { displayId?: string };
      toRef?: { displayId?: string };
    };
    return {
      forgeKind: "bitbucket-dc",
      repositoryUrl: `${this.hostDefinition.baseUrl}/scm/${projectKey}/${repoSlug}`,
      number: data.id,
      title: data.title,
      url: `${this.hostDefinition.baseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests/${data.id}`,
      state: data.state === "MERGED" ? "merged" : data.state === "DECLINED" ? "closed" : "open",
      headBranch: data.fromRef?.displayId ?? "unknown",
      baseBranch: data.toRef?.displayId ?? "main"
    };
  }

  public async listPullRequestsForBranch(params: {
    readonly repositorySlug: string;
    readonly headBranch: string;
  }): Promise<readonly LinkedPullRequest[]> {
    const { projectKey, repoSlug } = this.splitProjectAndRepo(params.repositorySlug);
    const url = `${this.hostDefinition.apiBaseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests?state=ALL`;
    await this.networkEvaluator.verifyUrl(url);
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` }
    });
    if (!res.ok) {
      throw new Error(`Bitbucket DC listPullRequestsForBranch failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      values?: Array<{
        id: number;
        title: string;
        state: string;
        fromRef?: { displayId?: string };
        toRef?: { displayId?: string };
      }>;
    };
    return (body.values ?? [])
      .filter((pr) => pr.fromRef?.displayId === params.headBranch)
      .map((data) => ({
        forgeKind: "bitbucket-dc" as const,
        repositoryUrl: `${this.hostDefinition.baseUrl}/scm/${projectKey}/${repoSlug}`,
        number: data.id,
        title: data.title,
        url: `${this.hostDefinition.baseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests/${data.id}`,
        state:
          data.state === "MERGED"
            ? ("merged" as const)
            : data.state === "DECLINED"
              ? ("closed" as const)
              : ("open" as const),
        headBranch: data.fromRef?.displayId ?? params.headBranch,
        baseBranch: data.toRef?.displayId ?? "main"
      }));
  }
}
