import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT = `Review the codebase and complete the following cleanup tasks:

1. **Fallback code removal**: Find and remove overly-defensive code added by AI assistants — such as:
   - try/catch blocks that swallow errors silently without re-throwing
   - commented-out code blocks left behind
   - placeholder "TODO: remove" stubs
   - unnecessary default cases that return null/empty/zero
   - anything that exists only to "just in case" — not to fix a real bug

2. **Dead code removal**: Find and remove code paths that are no longer used:
   - unused exports (functions, classes, variables)
   - unused imports
   - old feature branches that are now superseded
   - functions that only call other dead functions
   - code guarded by flags/config that are never set to the old value

3. **Docs update**: Review and update all .md files in the repo:
   - Update CHANGELOG if present
   - Update README if anything new warrants mention
   - Fix any outdated docs you notice
   - Add docs for anything new that lacks them
   - Remove docs for removed features

Be surgical. Do not refactor — only remove what's provably dead or provably fallback. Keep the changeset minimal and focused.`;

export default function featureEnd(pi: ExtensionAPI) {
  pi.registerCommand("feature-end", {
    description: "Run post-feature cleanup: remove fallback code, dead code, and update docs",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus("feature-end", "Running...");
      await pi.sendUserMessage(PROMPT, { deliverAs: "followUp" });
      if (ctx.hasUI) ctx.ui.notify("feature-end: cleanup prompt sent", "info");
    },
  });
}
