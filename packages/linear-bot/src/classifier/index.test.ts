import { describe, expect, it } from "vitest";
import { findTeamNamedRepo, sanitizeClassifierText } from "./index";
import type { RepoConfig } from "../types";

describe("sanitizeClassifierText", () => {
  it("removes OpenInspect mentions from classifier input", () => {
    expect(sanitizeClassifierText("Hi @openinspect please help with our repo")).toBe(
      "Hi please help with our repo"
    );
  });

  it("normalizes repeated whitespace after sanitizing mentions", () => {
    expect(sanitizeClassifierText("Hi   @OpenInspect\n\nplease help")).toBe("Hi please help");
  });

  it("returns an empty string for missing input", () => {
    expect(sanitizeClassifierText(null)).toBe("");
  });
});

describe("findTeamNamedRepo", () => {
  const repos: RepoConfig[] = [
    {
      id: "snarktank/untangle",
      owner: "snarktank",
      name: "untangle",
      fullName: "snarktank/untangle",
      displayName: "untangle",
      description: "untangle",
      defaultBranch: "main",
      private: true,
    },
    {
      id: "snarktank/open-inspect-untangle",
      owner: "snarktank",
      name: "open-inspect-untangle",
      fullName: "snarktank/open-inspect-untangle",
      displayName: "open-inspect-untangle",
      description: "open inspect for untangle",
      defaultBranch: "main",
      private: true,
    },
  ];

  it("returns a unique repo whose name exactly matches the Linear team name", () => {
    expect(findTeamNamedRepo(repos, "Untangle")).toEqual(repos[0]);
  });

  it("matches team names even when punctuation differs", () => {
    expect(findTeamNamedRepo(repos, "Open Inspect Untangle")).toEqual(repos[1]);
  });

  it("returns null when no repo name exactly matches the team name", () => {
    expect(findTeamNamedRepo(repos, "General")).toBeNull();
  });
});
