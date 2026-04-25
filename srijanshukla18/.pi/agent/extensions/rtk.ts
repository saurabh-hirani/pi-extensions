/**
 * RTK (Rewrite To Kit) Extension
 *
 * Intercepts agent bash tool calls and interactive user bash commands
 * (`!` / `!!`) and rewrites supported CLI commands (git, grep, cat,
 * vitest, eslint, docker, kubectl, etc.) into their `rtk`
 * equivalents via RTK's hook rewrite engine.
 */

import { createLocalBashOperations, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

type RewriteDecision =
  | { kind: "rewrite"; rewritten: string }
  | { kind: "pass"; reason: string };

async function rewriteWithRtk(pi: ExtensionAPI, command: string): Promise<RewriteDecision> {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "pass", reason: "empty" };
  if (trimmed === "rtk" || trimmed.startsWith("rtk ")) {
    return { kind: "pass", reason: "already-rtk" };
  }

  const result = await pi.exec("rtk", ["hook", "check", "--agent", "claude", command]);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (result.code === 0 && stdout) {
    return { kind: "rewrite", rewritten: stdout };
  }

  if (result.code === 1) {
    return { kind: "pass", reason: stdout || stderr || "no-rewrite" };
  }

  return {
    kind: "pass",
    reason: `hook-check-failed code=${result.code}${stderr ? ` stderr=${JSON.stringify(stderr)}` : ""}`,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("rtk", "RTK active");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: string };
    const command = input.command;
    if (typeof command !== "string") return undefined;

    const decision = await rewriteWithRtk(pi, command);
    if (decision.kind === "rewrite" && decision.rewritten !== command) {
      input.command = decision.rewritten;
      if (ctx.hasUI) {
        ctx.ui.setStatus("rtk", `rewrote: ${decision.rewritten}`);
      }
      return undefined;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus("rtk", `pass: ${command}`);
    }
    return undefined;
  });

  pi.on("user_bash", async (event, ctx) => {
    const local = createLocalBashOperations();
    const decision = await rewriteWithRtk(pi, event.command);
    const rewritten = decision.kind === "rewrite" ? decision.rewritten : event.command;

    if (ctx.hasUI) {
      if (decision.kind === "rewrite") {
        ctx.ui.setStatus("rtk", `user_bash rewrote: ${rewritten}`);
      } else {
        ctx.ui.setStatus("rtk", `user_bash pass: ${event.command}`);
      }
    }

    return {
      operations: {
        async exec(command, cwd, options) {
          const finalCommand = command === event.command ? rewritten : command;
          return local.exec(finalCommand, cwd, options);
        },
      },
    };
  });
}
