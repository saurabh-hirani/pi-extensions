/**
 * Prune Tool Results Extension
 *
 * Automatically strips old tool result content from the LLM context to prevent
 * geometric cost growth. No summarization, no LLM calls — just replaces old
 * tool result content with a minimal marker.
 *
 * - Session history is never modified (context hook operates on a deep clone)
 * - Keeps toolResult messages (required for API pairing) but empties their content
 * - Tracks and displays estimated cost savings in the footer
 *
 * Commands:
 *   /prune        — toggle pruning on/off
 *   /prune stats  — show cumulative savings
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keep full tool results from the last N user turns.
// A "turn" starts at each user message and includes all assistant/tool exchanges
// until the next user message.
const KEEP_RECENT_TURNS = 2;

const PRUNED_MARKER = "[output pruned from context]";

export default function pruneToolResults(pi: ExtensionAPI) {
	let enabled = true;

	// Cumulative savings tracking
	let totalTokensSaved = 0;
	let totalCostSaved = 0;
	let pruneCallCount = 0;

	function updateStatus(ctx: ExtensionContext) {
		if (!enabled || totalCostSaved === 0) {
			ctx.ui.setStatus("prune", undefined);
			return;
		}
		const costStr = totalCostSaved < 0.01 ? `$${totalCostSaved.toFixed(4)}` : `$${totalCostSaved.toFixed(3)}`;
		const tokensStr = totalTokensSaved > 1000 ? `${(totalTokensSaved / 1000).toFixed(1)}k` : `${totalTokensSaved}`;
		ctx.ui.setStatus("prune", ctx.ui.theme.fg("success", `✂ ${tokensStr} tok ${costStr} saved`));
	}

	pi.registerCommand("prune", {
		description: "Toggle pruning, or show stats with /prune stats",
		handler: async (args, ctx) => {
			if (args?.trim() === "stats") {
				ctx.ui.notify(
					`Pruning stats:\n` +
						`  Calls with pruning: ${pruneCallCount}\n` +
						`  Tokens saved: ${totalTokensSaved.toLocaleString()}\n` +
						`  Est. cost saved: $${totalCostSaved.toFixed(4)}`,
					"info",
				);
				return;
			}
			enabled = !enabled;
			ctx.ui.notify(`Tool result pruning: ${enabled ? "ON" : "OFF"}`);
			if (!enabled) {
				ctx.ui.setStatus("prune", undefined);
			} else {
				updateStatus(ctx);
			}
		},
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;

		const messages = event.messages;

		// Find turn boundaries — each user message starts a new turn
		const userIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "user") {
				userIndices.push(i);
			}
		}

		// Nothing to prune if within the keep window
		if (userIndices.length <= KEEP_RECENT_TURNS) return;

		// Everything before this index gets pruned
		const pruneBeforeIndex = userIndices[userIndices.length - KEEP_RECENT_TURNS];

		let charsSaved = 0;

		const pruned = messages.map((m, i) => {
			if (i >= pruneBeforeIndex) return m;
			if (m.role !== "toolResult") return m;

			const tr = m as { content: Array<{ type: string; text?: string; data?: string }> };
			let originalChars = 0;
			for (const block of tr.content) {
				if (block.type === "text" && block.text) originalChars += block.text.length;
				// base64 image data is especially expensive
				if (block.type === "image" && block.data) originalChars += block.data.length;
			}

			// Already small enough, not worth pruning
			if (originalChars <= PRUNED_MARKER.length) return m;

			charsSaved += originalChars - PRUNED_MARKER.length;
			return {
				...m,
				content: [{ type: "text" as const, text: PRUNED_MARKER }],
			};
		});

		if (charsSaved === 0) return;

		// Estimate savings using the same chars/4 heuristic pi uses internally
		const tokensSaved = Math.ceil(charsSaved / 4);
		const model = ctx.model;
		const costPerToken = model ? (model as any).cost.input / 1_000_000 : 0;
		const costSaved = tokensSaved * costPerToken;

		totalTokensSaved += tokensSaved;
		totalCostSaved += costSaved;
		pruneCallCount++;

		updateStatus(ctx);

		return { messages: pruned };
	});
}
