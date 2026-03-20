const GITHUB_API_BASE = "https://api.github.com";

async function githubRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "open-inspect-github-bot",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${path} failed: ${response.status} ${text}`);
  }

  return (await response.json()) as T;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  draft: boolean;
  mergeable: boolean | null;
  state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface PullRequestReviewComment {
  body: string;
  path: string;
  user: { login: string };
}

export async function fetchPullRequestDetails(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestDetails> {
  return githubRequest<PullRequestDetails>(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

export async function fetchPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string[]> {
  const files = await githubRequest<Array<{ filename: string }>>(
    token,
    `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`
  );
  return files.map((file) => file.filename);
}

export async function fetchPullRequestReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestReviewComment[]> {
  return githubRequest<PullRequestReviewComment[]>(
    token,
    `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100`
  );
}

export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  sha: string
): Promise<void> {
  await githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({
      merge_method: "merge",
      sha,
    }),
  });
}
