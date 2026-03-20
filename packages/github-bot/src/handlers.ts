import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  PullRequestReviewPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
  CheckRunPayload,
  CheckSuitePayload,
} from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken, postReaction, checkSenderPermission } from "./github-auth";
import {
  buildCodeReviewPrompt,
  buildCommentActionPrompt,
  buildMergePrepPrompt,
  buildRemediationPrompt,
} from "./prompts";
import { generateInternalToken } from "./utils/internal";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import {
  extractPrProvenance,
  hasOpenInspectLabel,
  type LinearPrProvenance,
} from "@open-inspect/shared";
import {
  aggregateCheckStatuses,
  createDefaultAutomationState,
  loadAutomationState,
  saveAutomationState,
  type AutomationCheckStatus,
  type PullRequestAutomationState,
} from "./automation-state";
import {
  fetchPullRequestDetails,
  fetchPullRequestFiles,
  fetchPullRequestReviewComments,
  mergePullRequest,
  type PullRequestDetails,
} from "./github-api";
import { classifyLowRiskFiles } from "./risk";

export type HandlerResult =
  | {
      outcome: "processed";
      handler_action: string;
      session_id?: string;
      message_id?: string;
    }
  | { outcome: "skipped"; skip_reason: string };

async function getAuthHeaders(env: Env, traceId: string): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-trace-id": traceId,
  };
}

async function createSession(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  params: {
    repoOwner: string;
    repoName: string;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    branch?: string | null;
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    title: params.title,
    model: params.model,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  if (params.branch) {
    body.branch = params.branch;
  }
  const response = await controlPlane.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session creation failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { sessionId: string };
  return result.sessionId;
}

async function sendPrompt(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  sessionId: string,
  params: { content: string; authorId: string }
): Promise<string> {
  const response = await controlPlane.fetch(`https://internal/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...params, source: "github" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { messageId: string };
  return result.messageId;
}

function stripMention(body: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`@${escaped}`, "gi"), "").trim();
}

function fireAndForgetReaction(
  log: Logger,
  token: string,
  url: string,
  meta: Record<string, unknown>
): void {
  postReaction(token, url, "eyes").then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
}

type CallerGatingResult =
  | { allowed: true; ghToken: string; headers: Record<string, string> }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  if (config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed" };
    }
  }

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason };
    }
  }

  return { allowed: true, ghToken, headers };
}

async function getBotAuth(
  env: Env,
  traceId: string
): Promise<{
  ghToken: string;
  headers: Record<string, string>;
}> {
  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  return { ghToken, headers };
}

type MergeQueueStatus =
  | "none"
  | "queued"
  | "active"
  | "blocked"
  | "ready_for_manual_merge"
  | "merged";

interface MergeQueueItem {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  prNumber: number;
  headBranch: string;
  headSha: string | null;
  linkedIssue: {
    issueId: string;
    issueIdentifier: string;
    organizationId?: string | null;
  };
  status: Exclude<MergeQueueStatus, "none">;
}

function mapReviewStatus(state: string): PullRequestAutomationState["reviewStatus"] {
  const normalized = state.toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested" || normalized === "request_changes") {
    return "changes_requested";
  }
  return "pending";
}

function mapCheckStatus(status: string, conclusion: string | null): AutomationCheckStatus {
  if (status !== "completed") {
    return "pending";
  }

  const normalizedConclusion = (conclusion ?? "").toLowerCase();
  if (
    normalizedConclusion === "success" ||
    normalizedConclusion === "neutral" ||
    normalizedConclusion === "skipped"
  ) {
    return "success";
  }

  return "failure";
}

async function fetchMergeQueueItem(
  env: Env,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<MergeQueueItem | null> {
  const response = await env.CONTROL_PLANE.fetch(
    `https://internal/merge-queue/items/${owner}/${repo}/${prNumber}`,
    { method: "GET", headers }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch merge queue item: ${response.status}`);
  }

  const data = (await response.json()) as { item: MergeQueueItem | null };
  return data.item;
}

async function finalizeMergeQueueItem(
  env: Env,
  headers: Record<string, string>,
  params: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    status: "blocked" | "ready_for_manual_merge" | "merged";
  }
): Promise<MergeQueueItem | null> {
  const response = await env.CONTROL_PLANE.fetch("https://internal/merge-queue/finalize", {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Failed to finalize merge queue item: ${response.status}`);
  }

  const data = (await response.json()) as {
    item: MergeQueueItem | null;
    nextItem: MergeQueueItem | null;
  };
  return data.nextItem;
}

async function createGithubAutomationSession(params: {
  env: Env;
  headers: Record<string, string>;
  config: ResolvedGitHubConfig;
  repoOwner: string;
  repoName: string;
  branch: string;
  title: string;
  prompt: string;
  authorId: string;
}): Promise<{ sessionId: string; messageId: string }> {
  const sessionId = await createSession(params.env.CONTROL_PLANE, params.headers, {
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    branch: params.branch,
    title: params.title,
    model: params.config.model,
    reasoningEffort: params.config.reasoningEffort,
  });

  const messageId = await sendPrompt(params.env.CONTROL_PLANE, params.headers, sessionId, {
    content: params.prompt,
    authorId: params.authorId,
  });

  return { sessionId, messageId };
}

async function startMergePrepSession(params: {
  env: Env;
  log: Logger;
  headers: Record<string, string>;
  repoOwner: string;
  repoName: string;
  queueItem: MergeQueueItem;
  isPublic: boolean;
}): Promise<void> {
  const repoFullName = `${params.repoOwner}/${params.repoName}`.toLowerCase();
  const config = await getGitHubConfig(params.env, repoFullName, params.log);
  const { sessionId, messageId } = await createGithubAutomationSession({
    env: params.env,
    headers: params.headers,
    config,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    branch: params.queueItem.headBranch,
    title: `GitHub: Merge prep PR #${params.queueItem.prNumber}`,
    prompt: buildMergePrepPrompt({
      owner: params.repoOwner,
      repo: params.repoName,
      number: params.queueItem.prNumber,
      issueIdentifier: params.queueItem.linkedIssue.issueIdentifier,
      base: params.queueItem.baseBranch,
      head: params.queueItem.headBranch,
      isPublic: params.isPublic,
    }),
    authorId: "github:merge-queue",
  });

  const state =
    (await loadAutomationState(
      params.env,
      params.repoOwner,
      params.repoName,
      params.queueItem.prNumber
    )) ??
    createDefaultAutomationState({
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      prNumber: params.queueItem.prNumber,
      linkedLinearIssue: {
        source: "linear",
        issueId: params.queueItem.linkedIssue.issueId,
        issueIdentifier: params.queueItem.linkedIssue.issueIdentifier,
        organizationId: params.queueItem.linkedIssue.organizationId ?? "",
        sessionId: "",
      },
      headBranch: params.queueItem.headBranch,
      baseBranch: params.queueItem.baseBranch,
      headSha: params.queueItem.headSha,
    });
  state.queueStatus = "active";
  state.headBranch = params.queueItem.headBranch;
  state.baseBranch = params.queueItem.baseBranch;
  state.headSha = params.queueItem.headSha;
  await saveAutomationState(params.env, state);

  params.log.info("automation.merge_prep_started", {
    repo: repoFullName,
    pull_number: params.queueItem.prNumber,
    session_id: sessionId,
    message_id: messageId,
  });
}

async function maybeStartNextMergePrep(params: {
  env: Env;
  log: Logger;
  headers: Record<string, string>;
  nextItem: MergeQueueItem | null;
  isPublic: boolean;
}): Promise<void> {
  if (!params.nextItem) return;
  await startMergePrepSession({
    env: params.env,
    log: params.log,
    headers: params.headers,
    repoOwner: params.nextItem.repoOwner,
    repoName: params.nextItem.repoName,
    queueItem: params.nextItem,
    isPublic: params.isPublic,
  });
}

async function evaluateLowRisk(
  ghToken: string,
  owner: string,
  repoName: string,
  prNumber: number,
  config: ResolvedGitHubConfig
): Promise<{ result: "low_risk" | "not_low_risk"; matchedFiles: string[] }> {
  const files = await fetchPullRequestFiles(ghToken, owner, repoName, prNumber);
  return classifyLowRiskFiles({
    files,
    allowGlobs: config.lowRiskFileAllowGlobs,
    blockGlobs: config.lowRiskFileBlockGlobs,
  });
}

async function continueQueueProcessingIfReady(params: {
  env: Env;
  log: Logger;
  headers: Record<string, string>;
  ghToken: string;
  owner: string;
  repoName: string;
  pr: PullRequestDetails;
  config: ResolvedGitHubConfig;
  state: PullRequestAutomationState;
  isPublic: boolean;
}): Promise<void> {
  if (params.state.queueStatus !== "active") {
    await saveAutomationState(params.env, params.state);
    return;
  }

  const lowRisk = await evaluateLowRisk(
    params.ghToken,
    params.owner,
    params.repoName,
    params.pr.number,
    params.config
  );
  params.state.lowRiskClassification = {
    result: lowRisk.result,
    matchedFiles: lowRisk.matchedFiles,
    updatedAt: Date.now(),
  };

  if (
    params.state.reviewStatus !== "approved" ||
    params.state.requiredCheckStatus !== "success" ||
    params.pr.mergeable !== true
  ) {
    await saveAutomationState(params.env, params.state);
    return;
  }

  if (lowRisk.result === "low_risk") {
    await mergePullRequest(
      params.ghToken,
      params.owner,
      params.repoName,
      params.pr.number,
      params.pr.head.sha
    );
    params.state.queueStatus = "merged";
    const nextItem = await finalizeMergeQueueItem(params.env, params.headers, {
      repoOwner: params.owner,
      repoName: params.repoName,
      prNumber: params.pr.number,
      status: "merged",
    });
    await saveAutomationState(params.env, params.state);
    await maybeStartNextMergePrep({
      env: params.env,
      log: params.log,
      headers: params.headers,
      nextItem,
      isPublic: params.isPublic,
    });
    return;
  }

  params.state.queueStatus = "ready_for_manual_merge";
  const nextItem = await finalizeMergeQueueItem(params.env, params.headers, {
    repoOwner: params.owner,
    repoName: params.repoName,
    prNumber: params.pr.number,
    status: "ready_for_manual_merge",
  });
  await saveAutomationState(params.env, params.state);
  await maybeStartNextMergePrep({
    env: params.env,
    log: params.log,
    headers: params.headers,
    nextItem,
    isPublic: params.isPublic,
  });
}

async function getLinearAutomationContext(params: {
  env: Env;
  headers: Record<string, string>;
  ghToken: string;
  owner: string;
  repoName: string;
  prNumber: number;
  headRef?: string;
  baseRef?: string;
  headSha?: string;
}): Promise<{
  pr: PullRequestDetails;
  provenance: LinearPrProvenance;
  queueStatus: MergeQueueStatus;
  state: PullRequestAutomationState;
} | null> {
  const pr = await fetchPullRequestDetails(
    params.ghToken,
    params.owner,
    params.repoName,
    params.prNumber
  );
  const provenance = extractPrProvenance(pr.body);
  if (!provenance || !hasOpenInspectLabel(pr.labels)) {
    return null;
  }

  const queueItem = await fetchMergeQueueItem(
    params.env,
    params.headers,
    params.owner,
    params.repoName,
    params.prNumber
  );
  const state =
    (await loadAutomationState(params.env, params.owner, params.repoName, params.prNumber)) ??
    createDefaultAutomationState({
      repoOwner: params.owner,
      repoName: params.repoName,
      prNumber: params.prNumber,
      linkedLinearIssue: provenance,
      headBranch: params.headRef ?? pr.head.ref,
      baseBranch: params.baseRef ?? pr.base.ref,
      headSha: params.headSha ?? pr.head.sha,
    });

  state.linkedLinearIssue = provenance;
  state.queueStatus = queueItem?.status ?? "none";
  state.headBranch = pr.head.ref;
  state.baseBranch = pr.base.ref;
  state.headSha = pr.head.sha;

  return {
    pr,
    provenance,
    queueStatus: queueItem?.status ?? "none",
    state,
  };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${payload.sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "review",
  };
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "self_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "auto_review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "auto_review",
  };
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${issue.number} comment`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "comment" });

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    commentActionInstructions: config.commentActionInstructions,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "comment",
  };
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${comment.id}/reactions`,
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${pr.number} review comment`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    base: pr.base.ref,
    head: pr.head.ref,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    filePath: comment.path,
    diffHunk: comment.diff_hunk,
    commentId: comment.id,
    commentActionInstructions: config.commentActionInstructions,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.login}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "review_comment",
  };
}

export async function handlePullRequestReview(
  env: Env,
  log: Logger,
  payload: PullRequestReviewPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: payloadPr, repository: repo, review } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (review.user.login !== env.GITHUB_BOT_USERNAME) {
    return { outcome: "skipped", skip_reason: "review_not_from_bot" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const { ghToken, headers } = await getBotAuth(env, traceId);
  const context = await getLinearAutomationContext({
    env,
    headers,
    ghToken,
    owner,
    repoName,
    prNumber: payloadPr.number,
    headRef: payloadPr.head.ref,
    baseRef: payloadPr.base.ref,
    headSha: payloadPr.head.sha,
  });
  if (!context) {
    return { outcome: "skipped", skip_reason: "not_linear_openinspect_pr" };
  }

  const { pr, state } = context;
  state.reviewStatus = mapReviewStatus(review.state);

  if (state.reviewStatus === "changes_requested") {
    if (state.lastRequestedChangesSha === pr.head.sha) {
      await saveAutomationState(env, state);
      return { outcome: "skipped", skip_reason: "duplicate_request_changes" };
    }

    if (state.remediationAttemptCount >= 2) {
      state.queueStatus = "blocked";
      let nextItem: MergeQueueItem | null = null;
      if (context.queueStatus !== "none") {
        nextItem = await finalizeMergeQueueItem(env, headers, {
          repoOwner: owner,
          repoName,
          prNumber: pr.number,
          status: "blocked",
        });
      }
      await saveAutomationState(env, state);
      await maybeStartNextMergePrep({
        env,
        log,
        headers,
        nextItem,
        isPublic: !repo.private,
      });
      return { outcome: "processed", handler_action: "remediation_blocked" };
    }

    const inlineComments = (
      await fetchPullRequestReviewComments(ghToken, owner, repoName, pr.number)
    )
      .filter((comment) => comment.user.login === env.GITHUB_BOT_USERNAME)
      .map((comment) => ({ path: comment.path, body: comment.body }));
    const failingChecks = Object.entries(state.checkStatuses)
      .filter(([, status]) => status === "failure")
      .map(([name]) => name);

    const { sessionId, messageId } = await createGithubAutomationSession({
      env,
      headers,
      config,
      repoOwner: owner,
      repoName,
      branch: pr.head.ref,
      title: `GitHub: Remediate PR #${pr.number}`,
      prompt: buildRemediationPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        reviewBody: review.body,
        base: pr.base.ref,
        head: pr.head.ref,
        failingChecks,
        inlineComments,
        isPublic: !repo.private,
      }),
      authorId: `github:${review.user.login}`,
    });

    state.remediationAttemptCount += 1;
    state.lastRequestedChangesSha = pr.head.sha;
    await saveAutomationState(env, state);

    return {
      outcome: "processed",
      handler_action: "remediation_started",
      session_id: sessionId,
      message_id: messageId,
    };
  }

  await saveAutomationState(env, state);
  await continueQueueProcessingIfReady({
    env,
    log,
    headers,
    ghToken,
    owner,
    repoName,
    pr,
    config,
    state,
    isPublic: !repo.private,
  });

  return { outcome: "processed", handler_action: "review_state_updated" };
}

export async function handleCheckRunEvent(
  env: Env,
  log: Logger,
  payload: CheckRunPayload,
  traceId: string
): Promise<HandlerResult> {
  const prNumber = payload.check_run.pull_requests?.[0]?.number;
  if (!prNumber) {
    return { outcome: "skipped", skip_reason: "check_run_without_pr" };
  }

  const owner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const { ghToken, headers } = await getBotAuth(env, traceId);
  const context = await getLinearAutomationContext({
    env,
    headers,
    ghToken,
    owner,
    repoName,
    prNumber,
    headSha: payload.check_run.head_sha,
  });
  if (!context) {
    return { outcome: "skipped", skip_reason: "not_linear_openinspect_pr" };
  }

  const { pr, state } = context;
  state.checkStatuses[payload.check_run.name] = mapCheckStatus(
    payload.check_run.status,
    payload.check_run.conclusion
  );
  state.requiredCheckStatus = aggregateCheckStatuses(state.checkStatuses);
  await saveAutomationState(env, state);

  await continueQueueProcessingIfReady({
    env,
    log,
    headers,
    ghToken,
    owner,
    repoName,
    pr,
    config,
    state,
    isPublic: !payload.repository.private,
  });

  return { outcome: "processed", handler_action: "check_run_updated" };
}

export async function handleCheckSuiteEvent(
  env: Env,
  log: Logger,
  payload: CheckSuitePayload,
  traceId: string
): Promise<HandlerResult> {
  const prNumber = payload.check_suite.pull_requests?.[0]?.number;
  if (!prNumber) {
    return { outcome: "skipped", skip_reason: "check_suite_without_pr" };
  }

  const owner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const { ghToken, headers } = await getBotAuth(env, traceId);
  const context = await getLinearAutomationContext({
    env,
    headers,
    ghToken,
    owner,
    repoName,
    prNumber,
    headRef: payload.check_suite.head_branch ?? undefined,
    headSha: payload.check_suite.head_sha,
  });
  if (!context) {
    return { outcome: "skipped", skip_reason: "not_linear_openinspect_pr" };
  }

  const { pr, state } = context;
  state.checkStatuses[`suite:${payload.check_suite.id}`] = mapCheckStatus(
    payload.check_suite.status,
    payload.check_suite.conclusion
  );
  state.requiredCheckStatus = aggregateCheckStatuses(state.checkStatuses);
  await saveAutomationState(env, state);

  await continueQueueProcessingIfReady({
    env,
    log,
    headers,
    ghToken,
    owner,
    repoName,
    pr,
    config,
    state,
    isPublic: !payload.repository.private,
  });

  return { outcome: "processed", handler_action: "check_suite_updated" };
}
