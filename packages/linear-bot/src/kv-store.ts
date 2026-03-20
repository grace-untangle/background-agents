/**
 * KV accessor helpers for config, issue sessions, and event deduplication.
 */

import type {
  Env,
  TriggerConfig,
  TeamRepoMapping,
  ProjectRepoMapping,
  ProjectMergeReadyConfig,
  IssueProjectStateSnapshot,
  UserPreferences,
  IssueSession,
} from "./types";
import { createLogger } from "./logger";

const log = createLogger("kv-store");

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
  triggerCommand: "@agent",
};

export async function getTeamRepoMapping(env: Env): Promise<TeamRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:team-repos", "json");
    if (data && typeof data === "object") return data as TeamRepoMapping;
  } catch (e) {
    log.debug("kv.get_team_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getProjectRepoMapping(env: Env): Promise<ProjectRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:project-repos", "json");
    if (data && typeof data === "object") return data as ProjectRepoMapping;
  } catch (e) {
    log.debug("kv.get_project_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getProjectMergeReadyConfig(env: Env): Promise<ProjectMergeReadyConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:project-merge-ready", "json");
    if (data && typeof data === "object") return data as ProjectMergeReadyConfig;
  } catch (e) {
    log.debug("kv.get_project_merge_ready_config_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getTriggerConfig(env: Env): Promise<TriggerConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:triggers", "json");
    if (data && typeof data === "object") {
      return { ...DEFAULT_TRIGGER_CONFIG, ...(data as Partial<TriggerConfig>) };
    }
  } catch (e) {
    log.debug("kv.get_trigger_config_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return DEFAULT_TRIGGER_CONFIG;
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const data = await env.LINEAR_KV.get(`user_prefs:${userId}`, "json");
    if (data && typeof data === "object") return data as UserPreferences;
  } catch (e) {
    log.debug("kv.get_user_preferences_failed", {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

export async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    if (data && typeof data === "object") return data as IssueSession;
  } catch (e) {
    log.debug("kv.lookup_issue_session_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function storeIssueSession(
  env: Env,
  issueId: string,
  session: IssueSession
): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7,
  });
}

function getIssueProjectStateKey(issueId: string): string {
  return `issue-project-state:${issueId}`;
}

export async function getIssueProjectState(
  env: Env,
  issueId: string
): Promise<IssueProjectStateSnapshot | null> {
  try {
    const raw = await env.LINEAR_KV.get(getIssueProjectStateKey(issueId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<IssueProjectStateSnapshot>;
      if (typeof parsed === "object" && parsed !== null) {
        return {
          id: typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null,
          name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null,
        };
      }
    } catch {
      // Backward compatibility for previously stored string-only IDs.
      return { id: raw, name: null };
    }
  } catch (e) {
    log.debug("kv.get_issue_project_state_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function storeIssueProjectState(
  env: Env,
  issueId: string,
  projectState: IssueProjectStateSnapshot | null
): Promise<void> {
  if (!projectState?.id && !projectState?.name) {
    await env.LINEAR_KV.delete(getIssueProjectStateKey(issueId));
    return;
  }

  await env.LINEAR_KV.put(
    getIssueProjectStateKey(issueId),
    JSON.stringify({
      id: projectState.id ?? null,
      name: projectState.name ?? null,
    }),
    {
      expirationTtl: 86400 * 30,
    }
  );
}

/**
 * Check if an event has already been processed (deduplication).
 */
export async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(`event:${eventKey}`);
  if (existing) return true;
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", { expirationTtl: 3600 });
  return false;
}
