export const OPEN_INSPECT_PR_LABEL = "open-inspect";

const OPEN_INSPECT_PROVENANCE_PREFIX = "<!-- open-inspect:provenance ";
const OPEN_INSPECT_PROVENANCE_SUFFIX = " -->";

export interface LinearPrProvenance {
  source: "linear";
  issueId: string;
  issueIdentifier: string;
  organizationId: string;
  sessionId: string;
  agentSessionId?: string;
}

export type OpenInspectPrProvenance = LinearPrProvenance;

export function buildPrProvenanceComment(provenance: OpenInspectPrProvenance): string {
  return `${OPEN_INSPECT_PROVENANCE_PREFIX}${JSON.stringify(provenance)}${OPEN_INSPECT_PROVENANCE_SUFFIX}`;
}

export function extractPrProvenance(
  body: string | null | undefined
): OpenInspectPrProvenance | null {
  if (!body) return null;

  const start = body.indexOf(OPEN_INSPECT_PROVENANCE_PREFIX);
  if (start === -1) return null;

  const jsonStart = start + OPEN_INSPECT_PROVENANCE_PREFIX.length;
  const end = body.indexOf(OPEN_INSPECT_PROVENANCE_SUFFIX, jsonStart);
  if (end === -1) return null;

  try {
    const parsed = JSON.parse(body.slice(jsonStart, end)) as Partial<OpenInspectPrProvenance>;
    if (
      parsed.source !== "linear" ||
      typeof parsed.issueId !== "string" ||
      typeof parsed.issueIdentifier !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }

    return {
      source: "linear",
      issueId: parsed.issueId,
      issueIdentifier: parsed.issueIdentifier,
      organizationId: parsed.organizationId,
      sessionId: parsed.sessionId,
      agentSessionId: typeof parsed.agentSessionId === "string" ? parsed.agentSessionId : undefined,
    };
  } catch {
    return null;
  }
}

export function hasOpenInspectLabel(
  labels: Array<string | { name?: string | null }> | null | undefined
): boolean {
  if (!labels) return false;

  return labels.some((label) => {
    if (typeof label === "string") {
      return label.toLowerCase() === OPEN_INSPECT_PR_LABEL;
    }

    return label.name?.toLowerCase() === OPEN_INSPECT_PR_LABEL;
  });
}
