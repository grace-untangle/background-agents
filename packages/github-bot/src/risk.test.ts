import { describe, expect, it } from "vitest";
import { classifyLowRiskFiles } from "./risk";

describe("classifyLowRiskFiles", () => {
  it("returns low risk when every file matches allow globs and none match block globs", () => {
    expect(
      classifyLowRiskFiles({
        files: ["docs/readme.md", "docs/setup/guide.md"],
        allowGlobs: ["docs/**"],
        blockGlobs: ["docs/private/**"],
      })
    ).toEqual({
      result: "low_risk",
      matchedFiles: ["docs/readme.md", "docs/setup/guide.md"],
    });
  });

  it("returns not low risk when any file falls outside the allowlist", () => {
    expect(
      classifyLowRiskFiles({
        files: ["docs/readme.md", "src/index.ts"],
        allowGlobs: ["docs/**"],
        blockGlobs: null,
      }).result
    ).toBe("not_low_risk");
  });

  it("returns not low risk when a file matches a block glob", () => {
    expect(
      classifyLowRiskFiles({
        files: ["docs/private/plan.md"],
        allowGlobs: ["docs/**"],
        blockGlobs: ["docs/private/**"],
      }).result
    ).toBe("not_low_risk");
  });
});
