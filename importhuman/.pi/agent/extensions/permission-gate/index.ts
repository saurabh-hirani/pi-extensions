import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { minimatch } from "minimatch";
import { parse as parseJsonc } from "jsonc-parser";

interface Config {
  allowedPaths: string[];
  sensitivePaths: string[];
  disallowedPaths: string[];

  allowedBashCommands: string[];
  sensitiveBashCommands: string[];
  disallowedBashCommands: string[];

  allowedTools: string[];
  sensitiveTools: string[];
  disallowedTools: string[];

  unknownToolsPolicy: "allow" | "prompt" | "deny";
}

interface NormalizedPathPattern {
  raw: string;
  expanded: string;
  isAbsolute: boolean;
  hasGlob: boolean;
}

function loadConfig(extensionDir: string): Config {
  try {
    const raw = readFileSync(`${extensionDir}/config.jsonc`, "utf-8");
    const parsed = parseJsonc(raw);
    return {
      allowedPaths: Array.isArray(parsed.allowedPaths) ? parsed.allowedPaths : [],
      sensitivePaths: Array.isArray(parsed.sensitivePaths) ? parsed.sensitivePaths : [],
      disallowedPaths: Array.isArray(parsed.disallowedPaths) ? parsed.disallowedPaths : [],
      allowedBashCommands: Array.isArray(parsed.allowedBashCommands) ? parsed.allowedBashCommands : [],
      sensitiveBashCommands: Array.isArray(parsed.sensitiveBashCommands) ? parsed.sensitiveBashCommands : [],
      disallowedBashCommands: Array.isArray(parsed.disallowedBashCommands) ? parsed.disallowedBashCommands : [],
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      sensitiveTools: Array.isArray(parsed.sensitiveTools) ? parsed.sensitiveTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      unknownToolsPolicy:
        parsed.unknownToolsPolicy === "allow" ||
        parsed.unknownToolsPolicy === "prompt" ||
        parsed.unknownToolsPolicy === "deny"
          ? parsed.unknownToolsPolicy
          : "prompt",
    };
  } catch {
    return {
      allowedPaths: [],
      sensitivePaths: [],
      disallowedPaths: [],
      allowedBashCommands: [],
      sensitiveBashCommands: [],
      disallowedBashCommands: [],
      allowedTools: [],
      sensitiveTools: [],
      disallowedTools: [],
      unknownToolsPolicy: "prompt",
    };
  }
}

function expandHome(input: string, home: string): string {
  return input.startsWith("~/") ? input.replace(/^~(?=\/)/, home) : input;
}

function hasGlobChars(input: string): boolean {
  return /[*?\[\]{}]/.test(input);
}

function normalizePathPattern(input: string, sessionRoot: string, home: string): NormalizedPathPattern {
  const expanded = expandHome(input, home);
  const isAbsolute = expanded.startsWith("/");
  const resolved = isAbsolute ? expanded : resolve(sessionRoot, expanded);
  return {
    raw: input,
    expanded: resolved,
    isAbsolute,
    hasGlob: hasGlobChars(input),
  };
}

function normalizeForGlob(path: string): string {
  return path.replace(/\\/g, "/");
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Non-glob path entries use prefix-scope matching in v1.
 * This keeps config semantics simple and predictable:
 * - directory-like paths allow descendants
 * - file-like paths also use lexical prefix matching
 *
 * Glob entries use minimatch against normalized absolute paths.
 * To make globstar patterns work reliably with absolute paths, match both:
 * - the normalized absolute path
 * - the same path with a leading slash removed
 */
function matchesPathPattern(targetPath: string, pattern: NormalizedPathPattern): boolean {
  if (pattern.hasGlob) {
    const normalizedTarget = normalizeForGlob(targetPath);
    const normalizedPattern = normalizeForGlob(pattern.expanded);
    return (
      minimatch(normalizedTarget, normalizedPattern, {
        dot: true,
        nocase: false,
      }) ||
      minimatch(stripLeadingSlash(normalizedTarget), stripLeadingSlash(normalizedPattern), {
        dot: true,
        nocase: false,
      })
    );
  }

  return targetPath === pattern.expanded || targetPath.startsWith(pattern.expanded + "/");
}

function matchesAnyPathPattern(targetPath: string, patterns: NormalizedPathPattern[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(targetPath, pattern));
}

function buildPatterns(commands: string[]): { pattern: RegExp; label: string }[] {
  return commands.map((cmd) => {
    if (cmd === ">") return { pattern: />/, label: "redirect" };
    if (cmd.includes(" ")) {
      const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { pattern: new RegExp(`\\b${escaped}`), label: cmd };
    }
    return { pattern: new RegExp(`\\b${cmd}\\b`), label: cmd };
  });
}

function matchesBashPatterns(command: string, patterns: { pattern: RegExp; label: string }[]): string[] {
  return patterns.filter((p) => p.pattern.test(command)).map((p) => p.label);
}

function isPathAwareTool(toolName: string): boolean {
  return ["read", "write", "edit"].includes(toolName);
}

function normalizeToolPath(path: string): string {
  /**
   * Pi uses @file syntax for file references. Mirror that behavior here so
   * permission checks evaluate the same path the underlying tool/harness reads.
   */
  return path.startsWith("@") ? path.slice(1) : path;
}

function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  if (["read", "write", "edit"].includes(toolName)) {
    const path = input.path;
    return typeof path === "string" ? [resolve(normalizeToolPath(path))] : [];
  }
  return [];
}

function isBashTool(toolName: string): boolean {
  return toolName === "bash";
}

/**
 * Tool allow/sensitive/disallowed lists apply only to non-path-aware,
 * non-bash tools. Path-aware tools use path policy, and bash uses
 * command policy.
 */
function isGenericTool(toolName: string): boolean {
  return !isPathAwareTool(toolName) && !isBashTool(toolName);
}

export default function permissionGate(pi: ExtensionAPI) {
  const home = process.env.HOME ?? "";
  const sessionRoot = resolve(process.cwd());
  const extDir = dirname(new URL(import.meta.url).pathname);
  const config = loadConfig(extDir);

  const allowedPathPatterns = config.allowedPaths.map((p) => normalizePathPattern(p, sessionRoot, home));
  const sensitivePathPatterns = config.sensitivePaths.map((p) => normalizePathPattern(p, sessionRoot, home));
  const disallowedPathPatterns = config.disallowedPaths.map((p) => normalizePathPattern(p, sessionRoot, home));

  const allowedBashPatterns = buildPatterns(config.allowedBashCommands);
  const sensitiveBashPatterns = buildPatterns(config.sensitiveBashCommands);
  const disallowedBashPatterns = buildPatterns(config.disallowedBashCommands);

  const allowedTools = new Set(config.allowedTools);
  const sensitiveTools = new Set(config.sensitiveTools);
  const disallowedTools = new Set(config.disallowedTools);

  const sessionAllowedFiles = new Set<string>();
  const sessionAllowedDirs = new Set<string>();
  const sessionAllowedBashCommands = new Set<string>();
  const sessionAllowedTools = new Set<string>();

  function isSessionPathAllowed(absPath: string): boolean {
    if (sessionAllowedFiles.has(absPath)) return true;
    for (const dir of sessionAllowedDirs) {
      if (absPath === dir || absPath.startsWith(dir + "/")) return true;
    }
    return false;
  }

  function allowPathFileForSession(absPath: string): void {
    sessionAllowedFiles.add(absPath);
  }

  function allowPathDirForSession(absPath: string): void {
    sessionAllowedDirs.add(dirname(absPath));
  }

  function isSessionBashAllowed(command: string): boolean {
    return sessionAllowedBashCommands.has(command);
  }

  function isSessionToolAllowed(toolName: string): boolean {
    return sessionAllowedTools.has(toolName);
  }

  function isInSessionRoot(absPath: string): boolean {
    return absPath === sessionRoot || absPath.startsWith(sessionRoot + "/");
  }

  function isAllowedPath(absPath: string): boolean {
    return matchesAnyPathPattern(absPath, allowedPathPatterns);
  }

  function isSensitivePath(absPath: string): boolean {
    return matchesAnyPathPattern(absPath, sensitivePathPatterns);
  }

  function isDisallowedPath(absPath: string): boolean {
    return matchesAnyPathPattern(absPath, disallowedPathPatterns);
  }

  async function promptForPathAccess(absPath: string, toolName: string, ctx: any): Promise<"allow-once" | "allow-file" | "allow-dir" | "deny"> {
    const choice = await ctx.ui.select(
      `🔐 ${toolName}: ${absPath}\n\nAllow access?`,
      ["Allow once", "Allow file for session", "Allow directory for session", "Deny"]
    );

    if (choice === "Allow file for session") return "allow-file";
    if (choice === "Allow directory for session") return "allow-dir";
    if (choice === "Allow once") return "allow-once";
    return "deny";
  }

  function blockWithReason(ctx: any, message: string, reason: string) {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }
    return { block: true, reason };
  }

  pi.on("session_start", async () => {
    sessionAllowedFiles.clear();
    sessionAllowedDirs.clear();
    sessionAllowedBashCommands.clear();
    sessionAllowedTools.clear();
  });

  pi.registerCommand("permissions", {
    description: "View permission-gate config and session approvals",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        `Session root: ${sessionRoot}`,
        "",
        "Configured allowedPaths:",
        ...(config.allowedPaths.length ? config.allowedPaths.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured sensitivePaths:",
        ...(config.sensitivePaths.length ? config.sensitivePaths.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured disallowedPaths:",
        ...(config.disallowedPaths.length ? config.disallowedPaths.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured allowedBashCommands:",
        ...(config.allowedBashCommands.length ? config.allowedBashCommands.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured sensitiveBashCommands:",
        ...(config.sensitiveBashCommands.length ? config.sensitiveBashCommands.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured disallowedBashCommands:",
        ...(config.disallowedBashCommands.length ? config.disallowedBashCommands.map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Configured allowedTools:",
        ...(config.allowedTools.length ? config.allowedTools.map((t) => `  ${t}`) : ["  (none)"]),
        "",
        "Configured sensitiveTools:",
        ...(config.sensitiveTools.length ? config.sensitiveTools.map((t) => `  ${t}`) : ["  (none)"]),
        "",
        "Configured disallowedTools:",
        ...(config.disallowedTools.length ? config.disallowedTools.map((t) => `  ${t}`) : ["  (none)"]),
        "",
        `Configured unknownToolsPolicy: ${config.unknownToolsPolicy}`,
        "",
        "Session-approved files:",
        ...(sessionAllowedFiles.size ? Array.from(sessionAllowedFiles).map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Session-approved directories:",
        ...(sessionAllowedDirs.size ? Array.from(sessionAllowedDirs).map((p) => `  ${p}`) : ["  (none)"]),
        "",
        "Session-approved bash commands:",
        ...(sessionAllowedBashCommands.size ? Array.from(sessionAllowedBashCommands).map((c) => `  ${c}`) : ["  (none)"]),
        "",
        "Session-approved tools:",
        ...(sessionAllowedTools.size ? Array.from(sessionAllowedTools).map((t) => `  ${t}`) : ["  (none)"]),
      ];

      const choice = await ctx.ui.select(lines.join("\n"), ["Keep all", "Reset session approvals"]);
      if (choice === "Reset session approvals") {
        sessionAllowedFiles.clear();
        sessionAllowedDirs.clear();
        sessionAllowedBashCommands.clear();
        sessionAllowedTools.clear();
        ctx.ui.notify("Session approvals cleared.", "info");
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isPathAwareTool(event.toolName)) {
      const paths = extractToolPaths(event.toolName, event.input as Record<string, unknown>);
      for (const absPath of paths) {
        if (isDisallowedPath(absPath)) {
          return blockWithReason(
            ctx,
            `Denied ${event.toolName}: ${absPath} is matched by disallowedPaths`,
            `Blocked by disallowedPaths: ${absPath}`
          );
        }

        if (isSessionPathAllowed(absPath)) {
          continue;
        }

        if (isSensitivePath(absPath)) {
          if (!ctx.hasUI) {
            return blockWithReason(
              ctx,
              `Denied ${event.toolName}: sensitive path requires confirmation but no UI is available (${absPath})`,
              `Sensitive path blocked (no UI): ${absPath}`
            );
          }
          const result = await promptForPathAccess(absPath, event.toolName, ctx);
          if (result === "allow-file") allowPathFileForSession(absPath);
          else if (result === "allow-dir") allowPathDirForSession(absPath);
          else if (result === "deny") {
            return blockWithReason(
              ctx,
              `Denied ${event.toolName}: user rejected access to ${absPath}`,
              `Blocked by user: ${absPath}`
            );
          }
          continue;
        }

        if (isInSessionRoot(absPath) || isAllowedPath(absPath)) {
          continue;
        }

        if (!ctx.hasUI) {
          return blockWithReason(
            ctx,
            `Denied ${event.toolName}: out-of-scope path requires confirmation but no UI is available (${absPath})`,
            `Out-of-scope path blocked (no UI): ${absPath}`
          );
        }
        const result = await promptForPathAccess(absPath, event.toolName, ctx);
        if (result === "allow-file") allowPathFileForSession(absPath);
        else if (result === "allow-dir") allowPathDirForSession(absPath);
        else if (result === "deny") {
          return blockWithReason(
            ctx,
            `Denied ${event.toolName}: user rejected access to ${absPath}`,
            `Blocked by user: ${absPath}`
          );
        }
      }

      return undefined;
    }

    if (isBashTool(event.toolName)) {
      const command = typeof (event.input as { command?: string }).command === "string" ? (event.input as { command: string }).command : "";

      if (matchesBashPatterns(command, disallowedBashPatterns).length > 0) {
        return blockWithReason(
          ctx,
          `Denied bash: command matched disallowedBashCommands (${command})`,
          `Blocked by disallowedBashCommands: ${command}`
        );
      }

      if (isSessionBashAllowed(command)) {
        return undefined;
      }

      if (matchesBashPatterns(command, allowedBashPatterns).length > 0) {
        return undefined;
      }

      if (!ctx.hasUI) {
        return blockWithReason(
          ctx,
          `Denied bash: confirmation required but no UI is available (${command})`,
          `Bash blocked (no UI): ${command}`
        );
      }

      const sensitiveMatches = matchesBashPatterns(command, sensitiveBashPatterns);
      const header = sensitiveMatches.length > 0
        ? `⚠️ bash (${sensitiveMatches.join(", ")}): ${command}`
        : `⚠️ bash: ${command}`;

      const choice = await ctx.ui.select(header + "\n\nAllow?", [
        "Allow once",
        "Allow this command for session",
        "Deny",
      ]);

      if (choice === "Allow this command for session") {
        sessionAllowedBashCommands.add(command);
        return undefined;
      }

      if (choice === "Allow once") {
        return undefined;
      }

      return blockWithReason(
        ctx,
        `Denied bash: user rejected command ${command}`,
        "Blocked by user"
      );
    }

    if (isGenericTool(event.toolName)) {
      if (disallowedTools.has(event.toolName)) {
        return blockWithReason(
          ctx,
          `Denied tool: ${event.toolName} is in disallowedTools`,
          `Tool disallowed: ${event.toolName}`
        );
      }

      if (isSessionToolAllowed(event.toolName)) {
        return undefined;
      }

      if (allowedTools.has(event.toolName)) {
        return undefined;
      }

      const shouldPrompt = sensitiveTools.has(event.toolName) || config.unknownToolsPolicy === "prompt";

      if (!shouldPrompt) {
        if (config.unknownToolsPolicy === "allow") return undefined;
        return blockWithReason(
          ctx,
          `Denied tool: ${event.toolName} is denied by unknownToolsPolicy`,
          `Unknown tool denied by policy: ${event.toolName}`
        );
      }

      if (!ctx.hasUI) {
        return blockWithReason(
          ctx,
          `Denied tool: ${event.toolName} requires confirmation but no UI is available`,
          `Unknown tool blocked (no UI): ${event.toolName}`
        );
      }

      const choice = await ctx.ui.select(
        `🛠️ tool: ${event.toolName}\n\nAllow?`,
        ["Allow once", "Allow tool for session", "Deny"]
      );

      if (choice === "Allow tool for session") {
        sessionAllowedTools.add(event.toolName);
        return undefined;
      }

      if (choice === "Allow once") {
        return undefined;
      }

      return blockWithReason(
        ctx,
        `Denied tool: user rejected ${event.toolName}`,
        "Blocked by user"
      );
    }

    return undefined;
  });
}
