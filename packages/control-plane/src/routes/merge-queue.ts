import { MergeQueueStore } from "../db/merge-queue";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

async function handleEnqueueMergeQueueItem(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as {
    repoOwner?: string;
    repoName?: string;
    baseBranch?: string;
    prNumber?: number;
    headBranch?: string;
    headSha?: string | null;
    linkedIssue?: {
      issueId?: string;
      issueIdentifier?: string;
      organizationId?: string | null;
    };
  };

  if (
    !body.repoOwner ||
    !body.repoName ||
    !body.baseBranch ||
    !body.headBranch ||
    typeof body.prNumber !== "number" ||
    !body.linkedIssue?.issueId ||
    !body.linkedIssue.issueIdentifier
  ) {
    return error("Invalid merge queue payload", 400);
  }

  const store = new MergeQueueStore(env.DB);
  const result = await store.enqueue({
    repoOwner: body.repoOwner,
    repoName: body.repoName,
    baseBranch: body.baseBranch,
    prNumber: body.prNumber,
    headBranch: body.headBranch,
    headSha: body.headSha ?? null,
    linkedIssue: {
      issueId: body.linkedIssue.issueId,
      issueIdentifier: body.linkedIssue.issueIdentifier,
      organizationId: body.linkedIssue.organizationId ?? null,
    },
  });

  return json(result);
}

async function handleGetMergeQueueItem(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const repoOwner = match.groups?.owner;
  const repoName = match.groups?.name;
  const prNumberValue = match.groups?.prNumber;
  if (!repoOwner || !repoName || !prNumberValue) {
    return error("Missing merge queue identifier", 400);
  }

  const prNumber = Number(prNumberValue);
  if (!Number.isFinite(prNumber)) {
    return error("Invalid PR number", 400);
  }

  const store = new MergeQueueStore(env.DB);
  const item = await store.getItem(repoOwner, repoName, prNumber);
  return json({ item });
}

async function handleFinalizeMergeQueueItem(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = (await request.json()) as {
    repoOwner?: string;
    repoName?: string;
    prNumber?: number;
    status?: "blocked" | "ready_for_manual_merge" | "merged";
  };

  if (
    !body.repoOwner ||
    !body.repoName ||
    typeof body.prNumber !== "number" ||
    (body.status !== "blocked" &&
      body.status !== "ready_for_manual_merge" &&
      body.status !== "merged")
  ) {
    return error("Invalid merge queue finalization payload", 400);
  }

  const store = new MergeQueueStore(env.DB);
  const result = await store.finalize({
    repoOwner: body.repoOwner,
    repoName: body.repoName,
    prNumber: body.prNumber,
    status: body.status,
  });

  return json(result);
}

export const mergeQueueRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/merge-queue/enqueue"),
    handler: handleEnqueueMergeQueueItem,
  },
  {
    method: "GET",
    pattern: parsePattern("/merge-queue/items/:owner/:name/:prNumber"),
    handler: handleGetMergeQueueItem,
  },
  {
    method: "POST",
    pattern: parsePattern("/merge-queue/finalize"),
    handler: handleFinalizeMergeQueueItem,
  },
];
