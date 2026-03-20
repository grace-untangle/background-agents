import { beforeEach, describe, expect, it } from "vitest";
import { MergeQueueStore } from "./merge-queue";

type Row = {
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  pr_number: number;
  head_branch: string;
  head_sha: string | null;
  linked_issue_json: string;
  status: "queued" | "active" | "blocked" | "ready_for_manual_merge" | "merged";
  created_at: number;
  updated_at: number;
};

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, Row>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  private key(repoOwner: string, repoName: string, prNumber: number): string {
    return `${repoOwner}:${repoName}:${prNumber}`;
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (normalized.includes("WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?")) {
      const [repoOwner, repoName, prNumber] = args as [string, string, number];
      return this.rows.get(this.key(repoOwner, repoName, prNumber)) ?? null;
    }

    if (normalized.includes("WHERE repo_owner = ? AND repo_name = ? AND status = 'active'")) {
      const [repoOwner, repoName] = args as [string, string];
      return (
        [...this.rows.values()].find(
          (row) =>
            row.repo_owner === repoOwner && row.repo_name === repoName && row.status === "active"
        ) ?? null
      );
    }

    if (normalized.includes("WHERE repo_owner = ? AND repo_name = ? AND status = 'queued'")) {
      const [repoOwner, repoName] = args as [string, string];
      return (
        [...this.rows.values()]
          .filter(
            (row) =>
              row.repo_owner === repoOwner && row.repo_name === repoName && row.status === "queued"
          )
          .sort((left, right) => left.created_at - right.created_at)[0] ?? null
      );
    }

    throw new Error(`Unexpected first() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (normalized.startsWith("INSERT INTO merge_queue_items")) {
      const [
        repoOwner,
        repoName,
        baseBranch,
        prNumber,
        headBranch,
        headSha,
        linkedIssueJson,
        status,
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string,
        string,
        number,
        string,
        string | null,
        string,
        Row["status"],
        number,
        number,
      ];
      this.rows.set(this.key(repoOwner, repoName, prNumber), {
        repo_owner: repoOwner,
        repo_name: repoName,
        base_branch: baseBranch,
        pr_number: prNumber,
        head_branch: headBranch,
        head_sha: headSha,
        linked_issue_json: linkedIssueJson,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (normalized.startsWith("UPDATE merge_queue_items SET base_branch = ?")) {
      const [
        baseBranch,
        headBranch,
        headSha,
        linkedIssueJson,
        updatedAt,
        repoOwner,
        repoName,
        prNumber,
      ] = args as [string, string, string | null, string, number, string, string, number];
      const key = this.key(repoOwner, repoName, prNumber);
      const current = this.rows.get(key);
      if (current) {
        this.rows.set(key, {
          ...current,
          base_branch: baseBranch,
          head_branch: headBranch,
          head_sha: headSha,
          linked_issue_json: linkedIssueJson,
          updated_at: updatedAt,
        });
      }
      return { meta: { changes: current ? 1 : 0 } };
    }

    if (normalized.startsWith("UPDATE merge_queue_items SET status = ?, updated_at = ?")) {
      const [status, updatedAt, repoOwner, repoName, prNumber] = args as [
        Row["status"],
        number,
        string,
        string,
        number,
      ];
      const key = this.key(repoOwner, repoName, prNumber);
      const current = this.rows.get(key);
      if (current) {
        this.rows.set(key, { ...current, status, updated_at: updatedAt });
      }
      return { meta: { changes: current ? 1 : 0 } };
    }

    if (normalized.startsWith("UPDATE merge_queue_items SET status = 'active', updated_at = ?")) {
      const [updatedAt, repoOwner, repoName, prNumber] = args as [number, string, string, number];
      const key = this.key(repoOwner, repoName, prNumber);
      const current = this.rows.get(key);
      if (current) {
        this.rows.set(key, { ...current, status: "active", updated_at: updatedAt });
      }
      return { meta: { changes: current ? 1 : 0 } };
    }

    throw new Error(`Unexpected run() query: ${query}`);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("MergeQueueStore", () => {
  let store: MergeQueueStore;

  beforeEach(() => {
    store = new MergeQueueStore(new FakeD1Database() as unknown as D1Database);
  });

  it("activates the first queued PR for a repo", async () => {
    const result = await store.enqueue({
      repoOwner: "Acme",
      repoName: "Widgets",
      baseBranch: "main",
      prNumber: 10,
      headBranch: "feature/one",
      linkedIssue: { issueId: "issue-1", issueIdentifier: "LIN-1" },
    });

    expect(result.activated).toBe(true);
    expect(result.item.status).toBe("active");
    expect(result.item.repoOwner).toBe("acme");
    expect(result.item.repoName).toBe("widgets");
  });

  it("queues later PRs behind the active item", async () => {
    await store.enqueue({
      repoOwner: "acme",
      repoName: "widgets",
      baseBranch: "main",
      prNumber: 10,
      headBranch: "feature/one",
      linkedIssue: { issueId: "issue-1", issueIdentifier: "LIN-1" },
    });

    const result = await store.enqueue({
      repoOwner: "acme",
      repoName: "widgets",
      baseBranch: "main",
      prNumber: 11,
      headBranch: "feature/two",
      linkedIssue: { issueId: "issue-2", issueIdentifier: "LIN-2" },
    });

    expect(result.activated).toBe(false);
    expect(result.item.status).toBe("queued");
  });

  it("activates the next queued PR when the active item is finalized", async () => {
    await store.enqueue({
      repoOwner: "acme",
      repoName: "widgets",
      baseBranch: "main",
      prNumber: 10,
      headBranch: "feature/one",
      linkedIssue: { issueId: "issue-1", issueIdentifier: "LIN-1" },
    });
    await store.enqueue({
      repoOwner: "acme",
      repoName: "widgets",
      baseBranch: "main",
      prNumber: 11,
      headBranch: "feature/two",
      linkedIssue: { issueId: "issue-2", issueIdentifier: "LIN-2" },
    });

    const result = await store.finalize({
      repoOwner: "acme",
      repoName: "widgets",
      prNumber: 10,
      status: "merged",
    });

    expect(result.item?.status).toBe("merged");
    expect(result.nextItem?.prNumber).toBe(11);
    expect(result.nextItem?.status).toBe("active");
  });
});
