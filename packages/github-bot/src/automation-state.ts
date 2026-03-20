import type { LinearPrProvenance } from "@open-inspect/shared";
import type { Env } from "./types";

export type AutomationReviewStatus = "pending" | "approved" | "changes_requested";
export type AutomationCheckStatus = "pending" | "success" | "failure";
export type AutomationQueueStatus =
  | "none"
  | "queued"
  | "active"
  | "blocked"
  | "ready_for_manual_merge"
  | "merged";
export type LowRiskResult = "unknown" | "low_risk" | "not_low_risk";

export interface PullRequestAutomationState {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  linkedLinearIssue: LinearPrProvenance | null;
  reviewStatus: AutomationReviewStatus;
  remediationAttemptCount: number;
  requiredCheckStatus: AutomationCheckStatus;
  lowRiskClassification: {
    result: LowRiskResult;
    matchedFiles: string[];
    updatedAt: number | null;
  };
  queueStatus: AutomationQueueStatus;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  checkStatuses: Record<string, AutomationCheckStatus>;
  lastRequestedChangesSha: string | null;
  updatedAt: number;
}

export function buildAutomationStateKey(
  repoOwner: string,
  repoName: string,
  prNumber: number
): string {
  return `pr-state:${repoOwner.toLowerCase()}/${repoName.toLowerCase()}:${prNumber}`;
}

export function createDefaultAutomationState(params: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  linkedLinearIssue?: LinearPrProvenance | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  headSha?: string | null;
}): PullRequestAutomationState {
  return {
    repoOwner: params.repoOwner.toLowerCase(),
    repoName: params.repoName.toLowerCase(),
    prNumber: params.prNumber,
    linkedLinearIssue: params.linkedLinearIssue ?? null,
    reviewStatus: "pending",
    remediationAttemptCount: 0,
    requiredCheckStatus: "pending",
    lowRiskClassification: {
      result: "unknown",
      matchedFiles: [],
      updatedAt: null,
    },
    queueStatus: "none",
    headBranch: params.headBranch ?? null,
    baseBranch: params.baseBranch ?? null,
    headSha: params.headSha ?? null,
    checkStatuses: {},
    lastRequestedChangesSha: null,
    updatedAt: Date.now(),
  };
}

export async function loadAutomationState(
  env: Env,
  repoOwner: string,
  repoName: string,
  prNumber: number
): Promise<PullRequestAutomationState | null> {
  const raw = await env.GITHUB_KV.get(
    buildAutomationStateKey(repoOwner, repoName, prNumber),
    "json"
  );
  if (!raw || typeof raw !== "object") return null;
  return raw as PullRequestAutomationState;
}

export async function saveAutomationState(
  env: Env,
  state: PullRequestAutomationState
): Promise<void> {
  const nextState = { ...state, updatedAt: Date.now() };
  await env.GITHUB_KV.put(
    buildAutomationStateKey(nextState.repoOwner, nextState.repoName, nextState.prNumber),
    JSON.stringify(nextState),
    { expirationTtl: 86400 * 30 }
  );
}

export function aggregateCheckStatuses(
  checkStatuses: Record<string, AutomationCheckStatus>
): AutomationCheckStatus {
  const statuses = Object.values(checkStatuses);
  if (statuses.length === 0) return "pending";
  if (statuses.some((status) => status === "failure")) return "failure";
  if (statuses.some((status) => status === "pending")) return "pending";
  return "success";
}
