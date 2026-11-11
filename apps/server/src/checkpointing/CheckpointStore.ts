import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface CaptureCheckpointResult {
  readonly checkpointRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly diffSummary: {
    readonly filesChanged: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface CheckpointDiffResult {
  readonly fromRef: string;
  readonly toRef: string;
  readonly patch: string;
  readonly diffSummary: {
    readonly filesChanged: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface RestoreCheckpointOptions {
  readonly providerSupportsRollback: boolean;
}

export class CheckpointRestoreRejectedError extends Error {
  public readonly code = "ERR_PROVIDER_ROLLBACK_UNSUPPORTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CheckpointRestoreRejectedError";
  }
}

function runGit(repoPath: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function parseShortStat(shortstatOutput: string): {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
} {
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(shortstatOutput);
  const insMatch = /(\d+)\s+insertions?\(\+\)/.exec(shortstatOutput);
  const delMatch = /(\d+)\s+deletions?\(-\)/.exec(shortstatOutput);
  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1]!, 10) : 0,
    insertions: insMatch ? Number.parseInt(insMatch[1]!, 10) : 0,
    deletions: delMatch ? Number.parseInt(delMatch[1]!, 10) : 0
  };
}

/**
 * Modeled after t3code's CheckpointStore:
 * Uses hidden Git refs (`refs/conductor/checkpoints/<threadId>/<turnId>`) and an isolated
 * temporary `GIT_INDEX_FILE` to snapshot and restore workspace state (including uncommitted
 * and untracked files) without adding commits to the user's branch or mutating `.git/index`.
 */
export class CheckpointStore {
  public static buildRefName(threadId: string, turnId: string): string {
    const safeThread = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeTurn = turnId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `refs/conductor/checkpoints/${safeThread}/${safeTurn}`;
  }

  public captureCheckpoint(params: {
    readonly repoPath: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly previousCheckpointRef?: string;
  }): CaptureCheckpointResult {
    const { repoPath, threadId, turnId, previousCheckpointRef } = params;
    const tempDir = mkdtempSync(join(tmpdir(), "conductor-idx-"));
    const tempIndexFile = join(tempDir, "index");

    try {
      const gitDir = runGit(repoPath, ["rev-parse", "--git-dir"]);
      const realIndexPath = resolve(repoPath, gitDir, "index");
      if (existsSync(realIndexPath)) {
        copyFileSync(realIndexPath, tempIndexFile);
      }

      const indexEnv = {
        GIT_INDEX_FILE: tempIndexFile,
        GIT_AUTHOR_NAME: "Conductor Checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@conductor.internal",
        GIT_COMMITTER_NAME: "Conductor Checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@conductor.internal"
      };

      // Stage all tracked, modified, and untracked files into the temporary index only
      runGit(repoPath, ["add", "-A"], indexEnv);
      const treeSha = runGit(repoPath, ["write-tree"], indexEnv);

      const commitArgs: string[] = ["commit-tree", treeSha];
      if (previousCheckpointRef && this.refExists(repoPath, previousCheckpointRef)) {
        const parentSha = runGit(repoPath, ["rev-parse", previousCheckpointRef]);
        commitArgs.push("-p", parentSha);
      } else if (this.hasHeadCommit(repoPath)) {
        const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
        commitArgs.push("-p", headSha);
      }
      commitArgs.push("-m", `conductor checkpoint thread=${threadId} turn=${turnId}`);

      const commitSha = runGit(repoPath, commitArgs, indexEnv);
      const checkpointRef = CheckpointStore.buildRefName(threadId, turnId);
      runGit(repoPath, ["update-ref", checkpointRef, commitSha]);

      let diffSummary = { filesChanged: 0, insertions: 0, deletions: 0 };
      const baseRef =
        previousCheckpointRef && this.refExists(repoPath, previousCheckpointRef)
          ? previousCheckpointRef
          : this.hasHeadCommit(repoPath)
            ? "HEAD"
            : undefined;

      if (baseRef) {
        const shortStat = runGit(repoPath, ["diff", "--shortstat", baseRef, checkpointRef]);
        diffSummary = parseShortStat(shortStat);
      }

      return {
        checkpointRef,
        commitSha,
        treeSha,
        diffSummary
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  public diffCheckpoints(
    repoPath: string,
    fromRef: string,
    toRef: string
  ): CheckpointDiffResult {
    const patch = runGit(repoPath, ["diff", fromRef, toRef]);
    const shortStat = runGit(repoPath, ["diff", "--shortstat", fromRef, toRef]);
    return {
      fromRef,
      toRef,
      patch,
      diffSummary: parseShortStat(shortStat)
    };
  }

  /**
   * Restores the workspace files to match `checkpointRef` without moving the user's branch HEAD.
   * Rejects before modifying any file if `options.providerSupportsRollback` is false.
   */
  public restoreCheckpoint(
    repoPath: string,
    checkpointRef: string,
    options: RestoreCheckpointOptions
  ): void {
    if (!options.providerSupportsRollback) {
      throw new CheckpointRestoreRejectedError(
        `Cannot restore checkpoint '${checkpointRef}': active provider does not support conversation rollback`
      );
    }

    if (!this.refExists(repoPath, checkpointRef)) {
      throw new Error(`Checkpoint ref '${checkpointRef}' does not exist in repository`);
    }

    const tempDir = mkdtempSync(join(tmpdir(), "conductor-restore-"));
    const tempIndexFile = join(tempDir, "index");

    try {
      const indexEnv = { GIT_INDEX_FILE: tempIndexFile };

      // 1. Read the target checkpoint tree into the temporary index
      runGit(repoPath, ["read-tree", checkpointRef], indexEnv);

      // 2. Determine all files currently in the working tree (tracked + untracked)
      const currentFilesRaw = runGit(repoPath, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z"
      ]);
      const currentFiles = currentFilesRaw ? currentFilesRaw.split("\0").filter(Boolean) : [];

      // 3. Determine all files present in the checkpoint tree
      const checkpointFilesRaw = runGit(
        repoPath,
        ["ls-files", "--cached", "-z"],
        indexEnv
      );
      const checkpointFilesSet = new Set(
        checkpointFilesRaw ? checkpointFilesRaw.split("\0").filter(Boolean) : []
      );

      // 4. Remove any files that were created after the checkpoint
      for (const relPath of currentFiles) {
        if (!checkpointFilesSet.has(relPath)) {
          rmSync(join(repoPath, relPath), { recursive: true, force: true });
        }
      }

      // 5. Materialize all files from the checkpoint index into the working tree
      runGit(repoPath, ["checkout-index", "-a", "-f"], indexEnv);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  public createThreadWorktree(params: {
    readonly repoPath: string;
    readonly threadId: string;
    readonly branchName: string;
  }): string {
    const safeThread = params.threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const worktreePath = resolve(params.repoPath, ".conductor", "worktrees", safeThread);
    runGit(params.repoPath, ["worktree", "add", "-b", params.branchName, worktreePath]);
    return worktreePath;
  }

  public removeThreadWorktree(repoPath: string, worktreePath: string): void {
    runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
  }

  public refExists(repoPath: string, refName: string): boolean {
    try {
      runGit(repoPath, ["show-ref", "--verify", "--quiet", refName]);
      return true;
    } catch {
      return false;
    }
  }

  private hasHeadCommit(repoPath: string): boolean {
    try {
      runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }
}
