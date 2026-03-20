CREATE TABLE IF NOT EXISTS merge_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_branch TEXT NOT NULL,
  head_sha TEXT,
  linked_issue_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'blocked', 'ready_for_manual_merge', 'merged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_owner, repo_name, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_merge_queue_repo_created
  ON merge_queue_items (repo_owner, repo_name, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_active_repo
  ON merge_queue_items (repo_owner, repo_name)
  WHERE status = 'active';
