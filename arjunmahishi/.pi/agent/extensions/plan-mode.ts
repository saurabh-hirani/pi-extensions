/**
 * Plan Mode Extension — OpenCode-style read-only planning mode for pi
 *
 * Toggle with Ctrl+Shift+P or the /plan command.
 * When active:
 *   - write and edit tools are blocked (no file modifications)
 *   - bash commands require confirmation before execution
 *   - system prompt instructs the LLM to analyze and suggest, not modify
 *   - a "PLAN" indicator shows in the footer
 *
 * Usage:
 *   Drop into ~/.pi/agent/extensions/plan-mode.ts (auto-discovered)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const PLAN_PROMPT_INJECTION = `
## PLAN MODE (READ-ONLY)
You are currently in **plan mode**. You MUST NOT make any changes to files.
- Do NOT use the write or edit tools.
- You may use read, grep, find, ls, and fetch_content freely.
- You may run bash commands ONLY for read-only investigation (e.g., git log, cat, grep, test commands). Never run commands that modify files, install packages, or change system state.
- Instead of making changes, provide a detailed plan:
  1. Explain what files need to change and why
  2. Show the exact code changes you would make (as diffs or code blocks)
  3. Describe the order of changes and any dependencies
  4. Note any risks or edge cases
- Be thorough and specific — the user will switch to build mode to execute your plan.
`.trim();

export default function (pi: ExtensionAPI) {
  let planMode = false;

  // Restore state from session
  pi.on("session_start", async (_event, ctx) => {
    planMode = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "plan-mode-state") {
        planMode = (entry as any).data?.enabled ?? false;
      }
    }
    updateStatus(ctx);
  });

  function updateStatus(ctx: { ui: { setStatus: (key: string, text: string) => void } }) {
    if (planMode) {
      ctx.ui.setStatus("plan-mode", "📋 PLAN");
    } else {
      ctx.ui.setStatus("plan-mode", "🔨 BUILD");
    }
  }

  function toggle(ctx: any) {
    planMode = !planMode;
    pi.appendEntry("plan-mode-state", { enabled: planMode });
    updateStatus(ctx);
    ctx.ui.notify(
      planMode ? "Plan mode ON — read-only, no file changes" : "Plan mode OFF — full access restored",
      "info"
    );
  }

  // Keyboard shortcut: Ctrl+Shift+P
  pi.registerShortcut("ctrl+shift+p", {
    description: "Toggle plan mode (read-only analysis)",
    handler: async (ctx) => {
      toggle(ctx);
    },
  });

  // Command: /plan
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only analysis, no file changes)",
    handler: async (_args, ctx) => {
      toggle(ctx);
    },
  });

  // Inject plan-mode instructions into the system prompt
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!planMode) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + PLAN_PROMPT_INJECTION,
    };
  });

  // Block write and edit tools
  pi.on("tool_call", async (event, ctx) => {
    if (!planMode) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: "Plan mode is active — file modifications are blocked. Describe the changes instead.",
      };
    }

    // Confirm bash commands
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      const ok = await ctx.ui.confirm(
        "Plan Mode — Bash",
        `Allow command?\n\n$ ${cmd}`
      );
      if (!ok) {
        return { block: true, reason: "Bash command denied by user in plan mode." };
      }
    }
  });
}
