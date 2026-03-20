function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/");
  let pattern = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    pattern += escapeRegex(char);
  }

  pattern += "$";
  return new RegExp(pattern);
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export function classifyLowRiskFiles(params: {
  files: string[];
  allowGlobs: string[] | null;
  blockGlobs: string[] | null;
}): { result: "low_risk" | "not_low_risk"; matchedFiles: string[] } {
  const files = params.files.map((file) => file.replaceAll("\\", "/"));
  const allowGlobs = params.allowGlobs ?? [];
  const blockGlobs = params.blockGlobs ?? [];

  if (files.length === 0 || allowGlobs.length === 0) {
    return { result: "not_low_risk", matchedFiles: [] };
  }

  if (files.some((file) => matchesAny(file, blockGlobs))) {
    return { result: "not_low_risk", matchedFiles: [] };
  }

  if (!files.every((file) => matchesAny(file, allowGlobs))) {
    return { result: "not_low_risk", matchedFiles: [] };
  }

  return { result: "low_risk", matchedFiles: files };
}
