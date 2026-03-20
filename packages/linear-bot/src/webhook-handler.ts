/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import type {
  Env,
  CallbackContext,
  LinearIssueDetails,
  AgentSessionWebhook,
  AgentSessionWebhookIssue,
  IssueUpdateWebhook,
  IssueProjectStateSnapshot,
  ProjectMergeReadyConfig,
} from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  fetchIssueDetails,
  updateAgentSession,
  getRepoSuggestions,
} from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { classifyRepo } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { getLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import {
  resolveStaticRepo,
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getProjectMergeReadyConfig,
  getUserPreferences,
  getIssueProjectState,
  lookupIssueSession,
  storeIssueProjectState,
  storeIssueSession,
} from "./kv-store";

const log = createLogger("handler");

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}

function getCurrentProjectStateId(issue: IssueUpdateWebhook["data"]): string | null {
  const directStateId =
    issue.projectStateId ??
    issue.projectStatusId ??
    issue.stateId ??
    issue.state?.id ??
    issue.projectState?.id ??
    null;
  return typeof directStateId === "string" && directStateId.length > 0 ? directStateId : null;
}

function normalizeStateName(stateName: string | null | undefined): string | null {
  if (typeof stateName !== "string") return null;
  const normalized = stateName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getCurrentProjectStateName(issue: IssueUpdateWebhook["data"]): string | null {
  return normalizeStateName(
    issue.stateName ?? issue.state?.name ?? issue.projectState?.name ?? null
  );
}

function getCurrentIssueProjectState(issue: IssueUpdateWebhook["data"]): IssueProjectStateSnapshot {
  return {
    id: getCurrentProjectStateId(issue),
    name: getCurrentProjectStateName(issue),
  };
}

function projectStatesEqual(
  previousState: IssueProjectStateSnapshot | null,
  currentState: IssueProjectStateSnapshot
): boolean {
  if (previousState?.id && currentState.id) {
    return previousState.id === currentState.id;
  }

  if (previousState?.name && currentState.name) {
    return normalizeStateName(previousState.name) === normalizeStateName(currentState.name);
  }

  return previousState?.id === currentState.id && previousState?.name === currentState.name;
}

function projectStateMatchesMergeReadyConfig(
  currentState: IssueProjectStateSnapshot,
  projectConfig: ProjectMergeReadyConfig[string]
): boolean {
  if (projectConfig.mergeReadyStateId && currentState.id === projectConfig.mergeReadyStateId) {
    return true;
  }

  const configuredStateName = normalizeStateName(projectConfig.mergeReadyStateName);
  if (configuredStateName && normalizeStateName(currentState.name) === configuredStateName) {
    return true;
  }

  return false;
}

async function enrichIssueProjectState(
  env: Env,
  webhook: IssueUpdateWebhook,
  currentState: IssueProjectStateSnapshot,
  traceId: string
): Promise<IssueProjectStateSnapshot> {
  if (currentState.name) {
    return currentState;
  }

  const client = await getLinearClient(env, webhook.organizationId);
  if (!client) {
    log.debug("issue_update.state_name_lookup_skipped", {
      trace_id: traceId,
      issue_id: webhook.data.id,
      issue_identifier: webhook.data.identifier,
      skip_reason: "no_linear_client",
    });
    return currentState;
  }

  const issueDetails = await fetchIssueDetails(client, webhook.data.id);
  const resolvedStateName = normalizeStateName(issueDetails?.state?.name ?? null);
  const resolvedStateId =
    issueDetails?.state?.id && issueDetails.state.id.length > 0 ? issueDetails.state.id : null;

  return {
    id: currentState.id ?? resolvedStateId,
    name: currentState.name ?? resolvedStateName,
  };
}

function buildMergePrepPrompt(params: {
  repoFullName: string;
  issueIdentifier: string;
  prNumber: number;
  baseBranch: string;
  headBranch: string;
  reviewStatus: string;
}): string {
  const { repoFullName, issueIdentifier, prNumber, baseBranch, headBranch, reviewStatus } = params;

  return `Prepare Pull Request #${prNumber} in ${repoFullName} for merge queue processing.

This session was authorized by moving Linear issue ${issueIdentifier} into the configured merge-ready column.

## Required first step
Before editing anything, fetch fresh PR state from GitHub with \`gh\`:
- \`gh pr view ${prNumber} --json number,title,body,headRefName,headRefOid,baseRefName,reviewDecision,mergeable\`
- \`gh pr view ${prNumber} --comments\`
- \`gh pr diff ${prNumber}\`

## Fixed merge-prep behavior
1. Work on the PR head branch \`${headBranch}\`
2. Fetch the latest \`${baseBranch}\`
3. Merge \`${baseBranch}\` into \`${headBranch}\` using a merge commit
4. Never rebase
5. Resolve conflicts if needed
6. Run the repo's required validation
7. Push the updated \`${headBranch}\` branch
8. Do not merge the PR
9. Leave the branch in a state where deterministic GitHub review and checks can rerun

## Current known state
- PR: #${prNumber}
- Base branch: ${baseBranch}
- Head branch: ${headBranch}
- Existing bot review status: ${reviewStatus}

When you're finished, summarize what changed and any remaining blockers.`;
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
      const headers = await getAuthHeaders(env, traceId);
      try {
        const stopRes = await env.CONTROL_PLANE.fetch(
          `https://internal/sessions/${existingSession.sessionId}/stop`,
          { method: "POST", headers }
        );
        log.info("agent_session.stopped", {
          trace_id: traceId,
          agent_session_id: agentSessionId,
          session_id: existingSession.sessionId,
          issue_id: issueId,
          stop_status: stopRes.status,
        });
      } catch (e) {
        log.error("agent_session.stop_failed", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
      await env.LINEAR_KV.delete(`issue:${issueId}`);
    }
  }

  log.info("agent_session.stop_handled", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleFollowUp(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const agentActivity = webhook.agentActivity;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  const existingSession = await lookupIssueSession(env, issue.id);
  if (!existingSession) return;

  const followUpContent = agentActivity?.body || comment?.body || "Follow-up on the issue.";

  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Processing follow-up message...",
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);
  let sessionContext = "";
  try {
    const eventsRes = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${existingSession.sessionId}/events?limit=20`,
      { method: "GET", headers }
    );
    if (eventsRes.ok) {
      const eventsData = (await eventsRes.json()) as {
        events: Array<{ type: string; data: Record<string, unknown> }>;
      };
      const recentTokens = eventsData.events.filter((e) => e.type === "token").slice(-1);
      if (recentTokens.length > 0) {
        const lastContent = String(recentTokens[0].data.content ?? "");
        if (lastContent) {
          sessionContext = `\n\n---\n**Previous agent response (summary):**\n${lastContent.slice(0, 500)}`;
        }
      }
    }
  } catch {
    /* best effort */
  }

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${existingSession.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: `Follow-up on ${issue.identifier}:\n\n${followUpContent}${sessionContext}`,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
      }),
    }
  );

  if (promptRes.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "response",
      body: `Follow-up sent to existing session.\n\n[View session](${env.WEB_APP_URL}/session/${existingSession.sessionId})`,
    });
  } else {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to send follow-up to the existing session.",
    });
  }

  log.info("agent_session.followup", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    session_id: existingSession.sessionId,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleNewSession(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  await updateAgentSession(client, agentSessionId, { plan: makePlan("start") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Analyzing issue and resolving repository...",
    },
    true
  );

  // Fetch full issue details for context
  const issueDetails = await fetchIssueDetails(client, issue.id);
  const labels = issueDetails?.labels || issue.labels || [];
  const labelNames = labels.map((l) => l.name);
  const projectInfo = issueDetails?.project || issue.project;

  // ─── Resolve repo ─────────────────────────────────────────────────────

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repoFullName: string | null = null;
  let classificationReasoning: string | null = null;

  // 1. Check project→repo mapping FIRST
  if (projectInfo?.id) {
    const projectMapping = await getProjectRepoMapping(env);
    const mapped = projectMapping[projectInfo.id];
    if (mapped) {
      repoOwner = mapped.owner;
      repoName = mapped.name;
      repoFullName = `${mapped.owner}/${mapped.name}`;
      classificationReasoning = `Project "${projectInfo.name}" is mapped to ${repoFullName}`;
    }
  }

  // 2. Check static team→repo mapping (override)
  if (!repoOwner) {
    const teamMapping = await getTeamRepoMapping(env);
    const teamId = issue.team?.id ?? "";
    if (teamId && teamMapping[teamId] && teamMapping[teamId].length > 0) {
      const staticRepo = resolveStaticRepo(teamMapping, teamId, labelNames);
      if (staticRepo) {
        repoOwner = staticRepo.owner;
        repoName = staticRepo.name;
        repoFullName = `${staticRepo.owner}/${staticRepo.name}`;
        classificationReasoning = `Team static mapping`;
      }
    }
  }

  // 3. Try Linear's built-in issueRepositorySuggestions API
  if (!repoOwner) {
    const repos = await getAvailableRepos(env, traceId);
    if (repos.length > 0) {
      const candidates = repos.map((r) => ({
        hostname: "github.com",
        repositoryFullName: `${r.owner}/${r.name}`,
      }));

      const suggestions = await getRepoSuggestions(client, issue.id, agentSessionId, candidates);
      const topSuggestion = suggestions.find((s) => s.confidence >= 0.7);
      if (topSuggestion) {
        const [owner, name] = topSuggestion.repositoryFullName.split("/");
        repoOwner = owner;
        repoName = name;
        repoFullName = topSuggestion.repositoryFullName;
        classificationReasoning = `Linear suggested ${repoFullName} (confidence: ${Math.round(topSuggestion.confidence * 100)}%)`;
      }
    }
  }

  // 4. Fall back to our LLM classification
  if (!repoOwner) {
    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "thought",
        body: "Classifying repository using AI...",
      },
      true
    );

    const classification = await classifyRepo(
      env,
      issue.title,
      issue.description,
      labelNames,
      projectInfo?.name,
      issue.team?.name ?? issueDetails?.team?.name,
      traceId
    );

    if (classification.needsClarification || !classification.repo) {
      const altList = (classification.alternatives || [])
        .map((r) => `- **${r.fullName}**: ${r.description}`)
        .join("\n");

      await emitAgentActivity(client, agentSessionId, {
        type: "elicitation",
        body: `I couldn't determine which repository to work on.\n\n${classification.reasoning}\n\n**Available repositories:**\n${altList || "None available"}\n\nPlease reply with the repository name, or configure a project→repo mapping.`,
      });

      log.warn("agent_session.classification_uncertain", {
        trace_id: traceId,
        issue_identifier: issue.identifier,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      });
      return;
    }

    repoOwner = classification.repo.owner;
    repoName = classification.repo.name;
    repoFullName = classification.repo.fullName;
    classificationReasoning = classification.reasoning;
  }

  if (!repoOwner || !repoName || !repoFullName) {
    await emitAgentActivity(client, agentSessionId, {
      type: "elicitation",
      body: "I couldn't determine which repository to work on. Please configure a project→repo or team→repo mapping and try again.",
    });
    log.warn("agent_session.repo_resolution_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
    });
    return;
  }

  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  if (
    integrationConfig.enabledRepos !== null &&
    !integrationConfig.enabledRepos.includes(repoFullName.toLowerCase())
  ) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for \`${repoFullName}\`.`,
    });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
    });
    return;
  }

  // ─── Resolve model ────────────────────────────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  const appUserId = webhook.appUserId;
  if (appUserId) {
    const prefs = await getUserPreferences(env, appUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;
  }

  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // ─── Create session ───────────────────────────────────────────────────

  await updateAgentSession(client, agentSessionId, { plan: makePlan("repo_resolved") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: `Creating coding session on ${repoFullName} (model: ${model})...`,
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);

  const sessionRes = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
    }),
  });

  if (!sessionRes.ok) {
    let sessionErrBody = "";
    try {
      sessionErrBody = await sessionRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionRes.status}: ${sessionErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
      http_status: sessionRes.status,
      response_body: sessionErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const session = (await sessionRes.json()) as { sessionId: string };

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner: repoOwner!,
    repoName: repoName!,
    model,
    agentSessionId,
    createdAt: Date.now(),
  });

  // Set externalUrls and update plan
  await updateAgentSession(client, agentSessionId, {
    externalUrls: [
      { label: "View Session", url: `${env.WEB_APP_URL}/session/${session.sessionId}` },
    ],
    plan: makePlan("session_created"),
  });

  // ─── Build and send prompt ────────────────────────────────────────────

  // Prefer Linear's promptContext (includes issue, comments, guidance)
  const prompt = webhook.agentSession.promptContext || buildPrompt(issue, issueDetails, comment);
  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName: repoFullName!,
    model,
    agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: prompt,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
        callbackContext,
      }),
    }
  );

  if (!promptRes.ok) {
    let promptErrBody = "";
    try {
      promptErrBody = await promptRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to send the prompt to the coding session.\n\n\`HTTP ${promptRes.status}: ${promptErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.send_prompt", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issue.identifier,
      http_status: promptRes.status,
      response_body: promptErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body: `Working on \`${repoFullName}\` with **${model}**.\n\n${classificationReasoning ? `*${classificationReasoning}*\n\n` : ""}[View session](${env.WEB_APP_URL}/session/${session.sessionId})`,
  });

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    model,
    classification_reasoning: classificationReasoning,
    duration_ms: Date.now() - startTime,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function handleAgentSessionEvent(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(webhook.agentSession.comment),
    org_id: webhook.organizationId,
  });

  // Stop handling
  if (webhook.action === "stopped" || webhook.action === "cancelled") {
    return handleStop(webhook, env, traceId);
  }

  if (!issue) {
    log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
    return;
  }

  // Follow-up handling (action: "prompted" with existing session)
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession && webhook.action === "prompted") {
    return handleFollowUp(webhook, issue, env, traceId);
  }

  // New session
  return handleNewSession(webhook, issue, env, traceId);
}

export async function handleIssueUpdateEvent(
  webhook: IssueUpdateWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const issue = webhook.data;
  const projectId = issue.project?.id;
  const mergeReadyConfig = await getProjectMergeReadyConfig(env);
  const projectConfig = projectId ? mergeReadyConfig[projectId] : undefined;
  const previousProjectState = await getIssueProjectState(env, issue.id);
  let currentProjectState = getCurrentIssueProjectState(issue);

  const requiresStateNameResolution = Boolean(
    projectConfig?.mergeReadyStateName && !currentProjectState.name
  );
  if (requiresStateNameResolution) {
    currentProjectState = await enrichIssueProjectState(env, webhook, currentProjectState, traceId);
  }

  await storeIssueProjectState(env, issue.id, currentProjectState);

  if (!projectId || (!currentProjectState.id && !currentProjectState.name)) {
    log.debug("issue_update.skipped", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      skip_reason: "missing_project_state",
    });
    return;
  }

  if (!projectConfig) {
    log.debug("issue_update.skipped", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      project_id: projectId,
      skip_reason: "project_not_merge_enabled",
    });
    return;
  }

  if (projectStatesEqual(previousProjectState, currentProjectState)) {
    log.debug("issue_update.skipped", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      project_id: projectId,
      project_state_id: currentProjectState.id,
      project_state_name: currentProjectState.name,
      skip_reason: "no_state_transition",
    });
    return;
  }

  if (!projectStateMatchesMergeReadyConfig(currentProjectState, projectConfig)) {
    log.debug("issue_update.skipped", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      project_id: projectId,
      previous_project_state_id: previousProjectState?.id,
      previous_project_state_name: previousProjectState?.name,
      current_project_state_id: currentProjectState.id,
      current_project_state_name: currentProjectState.name,
      merge_ready_state_id: projectConfig.mergeReadyStateId,
      merge_ready_state_name: projectConfig.mergeReadyStateName,
      skip_reason: "not_merge_ready_state",
    });
    return;
  }

  const issueSession = await lookupIssueSession(env, issue.id);
  if (!issueSession) {
    log.info("issue_update.skipped", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      project_id: projectId,
      skip_reason: "no_issue_session",
    });
    return;
  }

  const headers = await getAuthHeaders(env, traceId);
  const artifactsResponse = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${issueSession.sessionId}/artifacts`,
    { method: "GET", headers }
  );
  if (!artifactsResponse.ok) {
    log.warn("issue_update.artifacts_failed", {
      trace_id: traceId,
      session_id: issueSession.sessionId,
      issue_identifier: issue.identifier,
      http_status: artifactsResponse.status,
    });
    return;
  }

  const artifactsData = (await artifactsResponse.json()) as {
    artifacts: Array<{
      id: string;
      type: string;
      url: string | null;
      metadata: Record<string, unknown> | null;
    }>;
  };
  const prArtifact = artifactsData.artifacts.find((artifact) => artifact.type === "pr");
  if (!prArtifact?.metadata) {
    log.info("issue_update.skipped", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: issueSession.sessionId,
      skip_reason: "no_pr_artifact",
    });
    return;
  }

  const prNumber =
    typeof prArtifact.metadata.number === "number" ? prArtifact.metadata.number : null;
  const baseBranch = typeof prArtifact.metadata.base === "string" ? prArtifact.metadata.base : null;
  const headBranch = typeof prArtifact.metadata.head === "string" ? prArtifact.metadata.head : null;
  if (!prNumber || !baseBranch || !headBranch) {
    log.warn("issue_update.skipped", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: issueSession.sessionId,
      skip_reason: "missing_pr_metadata",
    });
    return;
  }

  const queueResponse = await env.CONTROL_PLANE.fetch("https://internal/merge-queue/enqueue", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner: issueSession.repoOwner,
      repoName: issueSession.repoName,
      baseBranch,
      prNumber,
      headBranch,
      headSha: null,
      linkedIssue: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        organizationId: webhook.organizationId,
      },
    }),
  });
  if (!queueResponse.ok) {
    log.warn("issue_update.queue_enqueue_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      pr_number: prNumber,
      http_status: queueResponse.status,
    });
    return;
  }

  const queueResult = (await queueResponse.json()) as {
    activated: boolean;
    item: {
      repoOwner: string;
      repoName: string;
      prNumber: number;
      baseBranch: string;
      headBranch: string;
    };
  };
  if (!queueResult.activated) {
    log.info("issue_update.enqueued", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: `${issueSession.repoOwner}/${issueSession.repoName}`,
      pr_number: prNumber,
      queue_state: "queued",
    });
    return;
  }

  const repoFullName = `${issueSession.repoOwner}/${issueSession.repoName}`;
  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  const sessionCreateResponse = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner: issueSession.repoOwner,
      repoName: issueSession.repoName,
      branch: headBranch,
      title: `${issue.identifier}: Merge prep for PR #${prNumber}`,
      model: integrationConfig.model ?? env.DEFAULT_MODEL,
      reasoningEffort: integrationConfig.reasoningEffort ?? undefined,
      userId: "linear-merge-queue",
      scmName: "Linear Merge Queue",
    }),
  });
  if (!sessionCreateResponse.ok) {
    log.warn("issue_update.merge_prep_session_create_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      pr_number: prNumber,
      http_status: sessionCreateResponse.status,
    });
    return;
  }

  const mergePrepSession = (await sessionCreateResponse.json()) as { sessionId: string };
  const prompt = buildMergePrepPrompt({
    repoFullName,
    issueIdentifier: issue.identifier,
    prNumber,
    baseBranch,
    headBranch,
    reviewStatus: "pending",
  });
  const promptResponse = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${mergePrepSession.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: prompt,
        authorId: "linear:merge-queue",
        source: "linear",
      }),
    }
  );

  log.info("issue_update.merge_prep_started", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    pr_number: prNumber,
    activated: true,
    session_id: mergePrepSession.sessionId,
    prompt_status: promptResponse.status,
  });
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body: string } | null
): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
    "",
  ];

  if (issue.description) {
    parts.push(issue.description);
  } else {
    parts.push("(No description provided)");
  }

  // Add context from full issue details
  if (issueDetails) {
    if (issueDetails.labels.length > 0) {
      parts.push("", `**Labels:** ${issueDetails.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueDetails.project) {
      parts.push(`**Project:** ${issueDetails.project.name}`);
    }
    if (issueDetails.assignee) {
      parts.push(`**Assignee:** ${issueDetails.assignee.name}`);
    }
    if (issueDetails.priorityLabel) {
      parts.push(`**Priority:** ${issueDetails.priorityLabel}`);
    }

    // Include recent comments for context
    if (issueDetails.comments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of issueDetails.comments.slice(-5)) {
        const author = c.user?.name || "Unknown";
        parts.push(`- **${author}:** ${c.body.slice(0, 200)}`);
      }
    }
  }

  if (comment?.body) {
    parts.push("", "---", `**Agent instruction:** ${comment.body}`);
  }

  parts.push(
    "",
    "Please implement the changes described in this issue. Create a pull request when done."
  );

  return parts.join("\n");
}
