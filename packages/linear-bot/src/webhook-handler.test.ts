import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, IssueUpdateWebhook, LinearIssueDetails } from "./types";

const mockGetProjectMergeReadyConfig = vi.fn();
const mockGetIssueProjectState = vi.fn();
const mockLookupIssueSession = vi.fn();
const mockStoreIssueProjectState = vi.fn();
const mockGetLinearClient = vi.fn();
const mockFetchIssueDetails = vi.fn();
const mockGenerateInternalToken = vi.fn();

vi.mock("./kv-store", () => ({
  getTeamRepoMapping: vi.fn(),
  getProjectRepoMapping: vi.fn(),
  getProjectMergeReadyConfig: mockGetProjectMergeReadyConfig,
  getUserPreferences: vi.fn(),
  getIssueProjectState: mockGetIssueProjectState,
  lookupIssueSession: mockLookupIssueSession,
  storeIssueProjectState: mockStoreIssueProjectState,
  storeIssueSession: vi.fn(),
}));

vi.mock("./utils/linear-client", () => ({
  getLinearClient: mockGetLinearClient,
  emitAgentActivity: vi.fn(),
  fetchIssueDetails: mockFetchIssueDetails,
  updateAgentSession: vi.fn(),
  getRepoSuggestions: vi.fn(),
}));

vi.mock("./utils/internal", () => ({
  generateInternalToken: mockGenerateInternalToken,
}));

vi.mock("./utils/integration-config", () => ({
  getLinearConfig: vi.fn(),
}));

const { escapeHtml, handleIssueUpdateEvent } = await import("./webhook-handler");

function createWebhook(data: Partial<IssueUpdateWebhook["data"]> = {}): IssueUpdateWebhook {
  return {
    type: "Issue",
    action: "update",
    organizationId: "org-1",
    data: {
      id: "issue-1",
      identifier: "UNT-123",
      title: "Test issue",
      project: { id: "proj-1", name: "Code Factory" },
      ...data,
    },
  };
}

function createEnv(fetchImpl: Env["CONTROL_PLANE"]["fetch"]): Env {
  return {
    LINEAR_KV: {} as KVNamespace,
    CONTROL_PLANE: { fetch: fetchImpl } as Fetcher,
    INTERNAL_CALLBACK_SECRET: "secret",
  } as unknown as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("escapeHtml", () => {
  it("escapes & to &amp;", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes < to &lt;", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes > to &gt;", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe(
      "&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;"
    );
  });

  it("does not escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("does not double-escape & in existing entities", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("handleIssueUpdateEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateInternalToken.mockResolvedValue("token-123");
    mockGetLinearClient.mockResolvedValue({ accessToken: "linear-token" });
    mockFetchIssueDetails.mockResolvedValue(null);
    mockGetProjectMergeReadyConfig.mockResolvedValue({
      "proj-1": { mergeReadyStateName: "merging" },
    });
    mockGetIssueProjectState.mockResolvedValue({ id: "state-0", name: "review" });
    mockLookupIssueSession.mockResolvedValue({
      sessionId: "session-1",
      issueId: "issue-1",
      issueIdentifier: "UNT-123",
      repoOwner: "snarktank",
      repoName: "untangle",
      model: "gpt-5.4",
      createdAt: Date.now(),
    });
    mockStoreIssueProjectState.mockResolvedValue(undefined);
  });

  it("enqueues when mergeReadyStateName matches the webhook state name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          artifacts: [
            {
              id: "artifact-1",
              type: "pr",
              url: null,
              metadata: { number: 42, base: "main", head: "open-inspect/branch" },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          activated: false,
          item: {
            repoOwner: "snarktank",
            repoName: "untangle",
            prNumber: 42,
            baseBranch: "main",
            headBranch: "open-inspect/branch",
          },
        })
      );

    await handleIssueUpdateEvent(
      createWebhook({
        state: { id: "state-1", name: "Merging" },
      }),
      createEnv(fetchMock),
      "trace-1"
    );

    expect(mockStoreIssueProjectState).toHaveBeenCalledWith(expect.anything(), "issue-1", {
      id: "state-1",
      name: "merging",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://internal/merge-queue/enqueue",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
    expect(mockFetchIssueDetails).not.toHaveBeenCalled();
  });

  it("looks up the current state name when the webhook only includes a state ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          artifacts: [
            {
              id: "artifact-1",
              type: "pr",
              url: null,
              metadata: { number: 42, base: "main", head: "open-inspect/branch" },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          activated: false,
          item: {
            repoOwner: "snarktank",
            repoName: "untangle",
            prNumber: 42,
            baseBranch: "main",
            headBranch: "open-inspect/branch",
          },
        })
      );

    mockFetchIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "UNT-123",
      title: "Test issue",
      url: "https://linear.app/issue/UNT-123",
      priority: 0,
      priorityLabel: "No priority",
      labels: [],
      project: { id: "proj-1", name: "Code Factory" },
      state: { id: "state-1", name: "merging" },
      assignee: null,
      team: { id: "team-1", key: "UNT", name: "Untangle" },
      comments: [],
    } satisfies LinearIssueDetails);

    await handleIssueUpdateEvent(
      createWebhook({
        stateId: "state-1",
      }),
      createEnv(fetchMock),
      "trace-2"
    );

    expect(mockFetchIssueDetails).toHaveBeenCalledWith({ accessToken: "linear-token" }, "issue-1");
    expect(mockStoreIssueProjectState).toHaveBeenCalledWith(expect.anything(), "issue-1", {
      id: "state-1",
      name: "merging",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips duplicate deliveries when the stored snapshot already matches", async () => {
    const fetchMock = vi.fn();

    mockGetIssueProjectState.mockResolvedValue({ id: null, name: "merging" });

    await handleIssueUpdateEvent(
      createWebhook({
        state: { id: "state-1", name: "merging" },
      }),
      createEnv(fetchMock),
      "trace-3"
    );

    expect(mockStoreIssueProjectState).toHaveBeenCalledWith(expect.anything(), "issue-1", {
      id: "state-1",
      name: "merging",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
