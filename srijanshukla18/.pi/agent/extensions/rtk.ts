/**
 * RTK (Rewrite To Kit) Extension
 *
 * Intercepts bash tool calls and rewrites common CLI commands
 * (git, grep, cat, vitest, eslint, docker, kubectl, etc.) into
 * their `rtk` equivalents. Shell meta-characters are left untouched.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SHELL_META = /[;&|<>`\n\r]|<<|\$\(/;

function nextToken(input: string, start = 0) {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) i++;
  if (i >= input.length) return null;

  const begin = i;
  while (i < input.length && !/\s/.test(input[i])) i++;
  return { token: input.slice(begin, i), next: i };
}

function mapToRtk(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.startsWith("rtk ") || trimmed === "rtk") return null;
  if (SHELL_META.test(trimmed)) return null;

  const envPrefixMatch = trimmed.match(
    /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*)/,
  );
  const envPrefix = envPrefixMatch?.[1] ?? "";
  const body = trimmed.slice(envPrefix.length).trimStart();

  const first = nextToken(body, 0);
  if (!first) return null;
  const cmd = first.token;
  const afterCmd = body.slice(first.next).trimStart();

  const second = nextToken(afterCmd, 0);
  const arg1 = second?.token;
  const afterArg1 = afterCmd.slice(second?.next ?? 0).trimStart();

  const third = nextToken(afterArg1, 0);
  const arg2 = third?.token;
  const afterArg2 = afterArg1.slice(third?.next ?? 0).trimStart();

  switch (cmd) {
    case "git":
    case "gh":
    case "cargo":
    case "curl":
    case "wget":
    case "json":
    case "deps":
    case "env":
    case "log":
    case "summary":
    case "proxy":
    case "tsc":
    case "prettier":
    case "playwright":
    case "prisma":
    case "pytest":
    case "golangci-lint":
      return `${envPrefix}rtk ${body}`;

    case "ls":
      return `${envPrefix}rtk ls${afterCmd ? ` ${afterCmd}` : ""}`;

    case "cat":
    case "head":
    case "tail":
      return `${envPrefix}rtk read${afterCmd ? ` ${afterCmd}` : ""}`;

    case "rg":
    case "grep":
      return `${envPrefix}rtk grep${afterCmd ? ` ${afterCmd}` : ""}`;

    case "ruff":
      if (arg1 === "check" || arg1 === "format") {
        return `${envPrefix}rtk ruff ${arg1}${afterArg1 ? ` ${afterArg1}` : ""}`;
      }
      return null;

    case "vitest":
    case "jest":
      return `${envPrefix}rtk vitest run${afterCmd ? ` ${afterCmd}` : ""}`;

    case "eslint":
    case "biome":
      return `${envPrefix}rtk lint${afterCmd ? ` ${afterCmd}` : ""}`;

    case "go":
      if (arg1 === "test" || arg1 === "build" || arg1 === "vet") {
        return `${envPrefix}rtk go ${afterCmd}`;
      }
      return null;

    case "pnpm":
      if (arg1 === "list" || arg1 === "outdated") {
        return `${envPrefix}rtk pnpm ${afterCmd}`;
      }
      return null;

    case "bundle":
      if (arg1 === "exec" && (arg2 === "rspec" || arg2 === "rubocop")) {
        return `${envPrefix}rtk ${arg2}${afterArg2 ? ` ${afterArg2}` : ""}`;
      }
      if (arg1 === "install" || arg1 === "update") {
        return `${envPrefix}rtk bundle ${afterCmd}`;
      }
      return null;

    case "rake":
    case "rails":
      if (arg1 === "test") {
        return `${envPrefix}rtk rake test${afterArg1 ? ` ${afterArg1}` : ""}`;
      }
      return null;

    case "rspec":
      return `${envPrefix}rtk rspec${afterCmd ? ` ${afterCmd}` : ""}`;

    case "rubocop":
      return `${envPrefix}rtk rubocop${afterCmd ? ` ${afterCmd}` : ""}`;

    case "docker":
      if (arg1 === "compose" || arg1 === "ps" || arg1 === "images" || arg1 === "logs") {
        return `${envPrefix}rtk docker ${afterCmd}`;
      }
      return null;

    case "kubectl":
      if (arg1 === "logs" || arg1 === "pods" || arg1 === "services") {
        return `${envPrefix}rtk kubectl ${afterCmd}`;
      }
      if (arg1 === "get" && arg2) {
        return `${envPrefix}rtk kubectl ${arg2}${afterArg2 ? ` ${afterArg2}` : ""}`;
      }
      return null;

    default:
      return null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("rtk", "RTK active");
    }
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: string };
    const command = input.command;
    if (typeof command !== "string") return undefined;

    const rewritten = mapToRtk(command);
    if (rewritten && rewritten !== command) {
      input.command = rewritten;
    }

    return undefined;
  });
}
