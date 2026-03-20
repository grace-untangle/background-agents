export type MergeQueueStatus =
  | "queued"
  | "active"
  | "blocked"
  | "ready_for_manual_merge"
  | "merged";

export interface MergeQueueLinkedIssue {
  issueId: string;
  issueIdentifier: string;
  organizationId?: string | null;
}

export interface MergeQueueItem {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  prNumber: number;
  headBranch: string;
  headSha: string | null;
  linkedIssue: MergeQueueLinkedIssue;
  status: MergeQueueStatus;
  createdAt: number;
  updatedAt: number;
}

interface MergeQueueRow {
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  pr_number: number;
  head_branch: string;
  head_sha: string | null;
  linked_issue_json: string;
  status: MergeQueueStatus;
  created_at: number;
  updated_at: number;
}

export class MergeQueueStore {
  constructor(private readonly db: D1Database) {}

  async enqueue(input: {
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    prNumber: number;
    headBranch: string;
    headSha?: string | null;
    linkedIssue: MergeQueueLinkedIssue;
  }): Promise<{ item: MergeQueueItem; activated: boolean }> {
    const repoOwner = input.repoOwner.toLowerCase();
    const repoName = input.repoName.toLowerCase();
    const existing = await this.getItem(repoOwner, repoName, input.prNumber);
    const now = Date.now();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE merge_queue_items
           SET base_branch = ?, head_branch = ?, head_sha = ?, linked_issue_json = ?, updated_at = ?
           WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`
        )
        .bind(
          input.baseBranch,
          input.headBranch,
          input.headSha ?? null,
          JSON.stringify(input.linkedIssue),
          now,
          repoOwner,
          repoName,
          input.prNumber
        )
        .run();

      const updated = await this.getItem(repoOwner, repoName, input.prNumber);
      if (!updated) {
        throw new Error("Failed to reload merge queue item after update");
      }
      return {
        item: updated,
        activated: updated.status === "active" && existing.status !== "active",
      };
    }

    const activeItem = await this.getActiveItem(repoOwner, repoName);
    const status: MergeQueueStatus = activeItem ? "queued" : "active";

    await this.db
      .prepare(
        `INSERT INTO merge_queue_items
         (repo_owner, repo_name, base_branch, pr_number, head_branch, head_sha, linked_issue_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        repoOwner,
        repoName,
        input.baseBranch,
        input.prNumber,
        input.headBranch,
        input.headSha ?? null,
        JSON.stringify(input.linkedIssue),
        status,
        now,
        now
      )
      .run();

    const item = await this.getItem(repoOwner, repoName, input.prNumber);
    if (!item) {
      throw new Error("Failed to load merge queue item after insert");
    }

    return { item, activated: status === "active" };
  }

  async getItem(
    repoOwner: string,
    repoName: string,
    prNumber: number
  ): Promise<MergeQueueItem | null> {
    const row = await this.db
      .prepare(
        `SELECT repo_owner, repo_name, base_branch, pr_number, head_branch, head_sha, linked_issue_json, status, created_at, updated_at
         FROM merge_queue_items
         WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase(), prNumber)
      .first<MergeQueueRow>();

    return row ? this.mapRow(row) : null;
  }

  async getActiveItem(repoOwner: string, repoName: string): Promise<MergeQueueItem | null> {
    const row = await this.db
      .prepare(
        `SELECT repo_owner, repo_name, base_branch, pr_number, head_branch, head_sha, linked_issue_json, status, created_at, updated_at
         FROM merge_queue_items
         WHERE repo_owner = ? AND repo_name = ? AND status = 'active'
         LIMIT 1`
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase())
      .first<MergeQueueRow>();

    return row ? this.mapRow(row) : null;
  }

  async finalize(input: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    status: Exclude<MergeQueueStatus, "queued" | "active">;
  }): Promise<{ item: MergeQueueItem | null; nextItem: MergeQueueItem | null }> {
    const repoOwner = input.repoOwner.toLowerCase();
    const repoName = input.repoName.toLowerCase();
    const now = Date.now();

    await this.db
      .prepare(
        `UPDATE merge_queue_items
         SET status = ?, updated_at = ?
         WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`
      )
      .bind(input.status, now, repoOwner, repoName, input.prNumber)
      .run();

    const nextQueuedRow = await this.db
      .prepare(
        `SELECT repo_owner, repo_name, base_branch, pr_number, head_branch, head_sha, linked_issue_json, status, created_at, updated_at
         FROM merge_queue_items
         WHERE repo_owner = ? AND repo_name = ? AND status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .bind(repoOwner, repoName)
      .first<MergeQueueRow>();

    if (nextQueuedRow) {
      await this.db
        .prepare(
          `UPDATE merge_queue_items
           SET status = 'active', updated_at = ?
           WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`
        )
        .bind(now, repoOwner, repoName, nextQueuedRow.pr_number)
        .run();
    }

    return {
      item: await this.getItem(repoOwner, repoName, input.prNumber),
      nextItem: nextQueuedRow
        ? await this.getItem(repoOwner, repoName, nextQueuedRow.pr_number)
        : null,
    };
  }

  private mapRow(row: MergeQueueRow): MergeQueueItem {
    return {
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      baseBranch: row.base_branch,
      prNumber: row.pr_number,
      headBranch: row.head_branch,
      headSha: row.head_sha,
      linkedIssue: JSON.parse(row.linked_issue_json) as MergeQueueLinkedIssue,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
