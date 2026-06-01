import type { Command } from "commander";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJson, outputResult, outputError } from "../lib/output";

const require = createRequire(import.meta.url);

// The agent's reasoning is driven by a copy of SKILL.md that was loaded into
// its harness/skill-library at some point in the past. That copy does NOT
// auto-refresh when the CLI is upgraded via npm. The authoritative SKILL.md,
// however, ships inside the npm package (see package.json "files"). These
// commands let an agent locate, print, and verify the freshness of the
// bundled skill so it can re-load it after an `npm update`.

// Resolve the package root regardless of whether we run from source (bin/) or
// the bundled build (dist/bin/). Mirrors getPackageVersion() in bin/acp.ts.
function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up from this file looking for a package.json that owns SKILL.md.
  // src/commands/ -> ../../ ; dist/ layouts -> ../ or ../../
  const candidates = [
    join(here, "..", ".."),
    join(here, ".."),
    join(here, "..", "..", ".."),
  ];
  for (const root of candidates) {
    if (existsSync(join(root, "package.json")) && existsSync(join(root, "SKILL.md"))) {
      return root;
    }
  }
  // Fallback: nearest package.json even if SKILL.md is missing.
  for (const root of candidates) {
    if (existsSync(join(root, "package.json"))) return root;
  }
  return here;
}

function getPackageVersion(): string {
  for (const p of ["../../package.json", "../package.json", "../../../package.json"]) {
    try {
      const pkg = require(p) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

function getSkillPath(): string {
  return join(resolvePackageRoot(), "SKILL.md");
}

function readSkill(): { path: string; content: string } {
  const path = getSkillPath();
  if (!existsSync(path)) {
    throw new Error(
      "Bundled SKILL.md not found. Reinstall the CLI: `npm install -g @virtuals-protocol/acp-cli@latest`."
    );
  }
  return { path, content: readFileSync(path, "utf8") };
}

function hashContent(content: string): string {
  // Short, stable content fingerprint the agent can record and compare against.
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description(
      "Inspect the SKILL.md that ships with this CLI version. Use `skill check` to detect when your loaded skill is stale after an upgrade."
    );

  skill
    .command("path")
    .description("Print the absolute path to the bundled SKILL.md")
    .action((_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const path = getSkillPath();
        if (json) {
          outputResult(json, { path, exists: existsSync(path) });
        } else {
          console.log(path);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  skill
    .command("print")
    .description("Print the full bundled SKILL.md to stdout (re-load this after an upgrade)")
    .action((_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { path, content } = readSkill();
        if (json) {
          outputResult(json, {
            path,
            version: getPackageVersion(),
            skillHash: hashContent(content),
            content,
          });
        } else {
          process.stdout.write(content);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  skill
    .command("check")
    .description(
      "Report the bundled skill's CLI version + content hash. Pass --against <version|hash> (whatever your harness recorded) to detect drift; upToDate=false means re-load the skill via `acp skill print`."
    )
    .option(
      "--against <versionOrHash>",
      "The CLI version or skill hash your currently-loaded skill was sourced from"
    )
    .action((opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { path, content } = readSkill();
        const version = getPackageVersion();
        const skillHash = hashContent(content);

        let upToDate: boolean | null = null;
        if (opts.against) {
          const against = String(opts.against).trim();
          upToDate = against === version || against === skillHash;
        }

        const payload: Record<string, unknown> = {
          version,
          skillHash,
          path,
          upToDate,
        };
        if (upToDate === false) {
          payload.action = "reload";
          payload.hint =
            "Your loaded skill is stale. Re-load the authoritative skill with `acp skill print` (or read the file at `path`) and prefer it over your cached copy.";
        }

        if (json) {
          outputResult(json, payload);
        } else {
          console.log(`CLI version : ${version}`);
          console.log(`Skill hash  : ${skillHash}`);
          console.log(`Skill path  : ${path}`);
          if (upToDate === null) {
            console.log(
              "\nPass --against <version|hash> (what your loaded skill was sourced from) to check for drift."
            );
          } else if (upToDate) {
            console.log("\nUp to date — your loaded skill matches the bundled skill.");
          } else {
            console.log(
              "\nSTALE — your loaded skill differs from the bundled one. Re-load it with `acp skill print`."
            );
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
