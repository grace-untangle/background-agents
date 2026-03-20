import { describe, expect, it } from "vitest";
import {
  buildPrProvenanceComment,
  extractPrProvenance,
  hasOpenInspectLabel,
} from "./pr-provenance";

describe("pr provenance helpers", () => {
  it("round-trips Linear provenance through PR body comments", () => {
    const comment = buildPrProvenanceComment({
      source: "linear",
      issueId: "issue-123",
      issueIdentifier: "LIN-123",
      organizationId: "org-1",
      sessionId: "session-1",
      agentSessionId: "agent-session-1",
    });

    expect(extractPrProvenance(`body\n\n${comment}`)).toEqual({
      source: "linear",
      issueId: "issue-123",
      issueIdentifier: "LIN-123",
      organizationId: "org-1",
      sessionId: "session-1",
      agentSessionId: "agent-session-1",
    });
  });

  it("requires the stable open-inspect label", () => {
    expect(hasOpenInspectLabel([{ name: "open-inspect" }])).toBe(true);
    expect(hasOpenInspectLabel(["OPEN-INSPECT"])).toBe(true);
    expect(hasOpenInspectLabel([{ name: "other" }])).toBe(false);
  });
});
