/**
 * Cost Tracker Extension
 *
 * Reports token usage and per-turn costs as a status line item with a
 * fixed-width sparkline that scrolls to show the most recent turns.
 *
 * Commands:
 *   /cost-chart  - Toggle a widget showing the full session cost chart
 *
 * Status example:
 *   ↑12.3k ↓1.2k  …▄▅▅▆▇█ $0.73 (+$0.09)
 *
 * Full chart widget:
 *   session cost ▁▂▃▃▄▅▅▆▇█▃▂▁▄▅▆▇█▁▂ $0.73 (20 turns)
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOOTER_CHART_WIDTH = 20;
const FULL_CHART_MAX_WIDTH = 80;
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
	if (values.length === 0) return "";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	return values
		.map((v) => SPARK_BLOCKS[Math.round(((v - min) / range) * (SPARK_BLOCKS.length - 1))])
		.join("");
}

function formatCost(cost: number): string {
	if (cost < 0.01) return cost.toFixed(4);
	return cost.toFixed(2);
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1)}k`;
}

interface SessionStats {
	input: number;
	output: number;
	totalCost: number;
	turnCosts: number[];
}

function computeStats(ctx: ExtensionContext): SessionStats {
	let input = 0;
	let output = 0;
	let totalCost = 0;
	const turnCosts: number[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "assistant") continue;
		const msg = entry.message as AssistantMessage;
		input += msg.usage.input;
		output += msg.usage.output;
		const cost = msg.usage.cost.total;
		totalCost += cost;
		turnCosts.push(cost);
	}

	return { input, output, totalCost, turnCosts };
}

export default function costTracker(pi: ExtensionAPI) {
	let showFullChart = false;

	function updateFullChart(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (!showFullChart) {
			ctx.ui.setWidget("cost-chart", undefined);
			return;
		}

		ctx.ui.setWidget("cost-chart", (_tui, theme) => {
			const { turnCosts, totalCost } = computeStats(ctx);

			// Wrap chart across multiple lines if needed
			const fullChart = sparkline(turnCosts);
			const lines: string[] = [];
			for (let i = 0; i < fullChart.length; i += FULL_CHART_MAX_WIDTH) {
				const chunk = fullChart.slice(i, i + FULL_CHART_MAX_WIDTH);
				lines.push(theme.fg("accent", chunk));
			}
			let summary = theme.fg("dim", "$");
			summary += theme.fg("success", formatCost(totalCost));
			summary += theme.fg("dim", ` (${turnCosts.length} turns)`);

			return {
				render: () => [...lines, summary],
				invalidate: () => {},
			};
		});
	}

	pi.registerCommand("cost-chart", {
		description: "Toggle full session cost chart",
		handler: async (_args, ctx) => {
			showFullChart = !showFullChart;
			updateFullChart(ctx);
		},
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const theme = ctx.ui.theme;
		const { input, output, totalCost, turnCosts } = computeStats(ctx);

		const displayCosts = turnCosts.slice(-FOOTER_CHART_WIDTH);
		const truncated = turnCosts.length > FOOTER_CHART_WIDTH;
		const chart = sparkline(displayCosts);
		const lastTurnCost = turnCosts.length > 0 ? turnCosts[turnCosts.length - 1] : 0;

		let status = theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}  `);
		if (truncated) status += theme.fg("dim", "…");
		if (chart) status += theme.fg("accent", chart) + " ";
		status += theme.fg("dim", "$");
		status += theme.fg("success", formatCost(totalCost));
		if (turnCosts.length > 0) {
			status += theme.fg("dim", ` (+$${formatCost(lastTurnCost)})`);
		}

		ctx.ui.setStatus("cost-tracker", status);
	}

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (_event, ctx) => {
		updateStatus(ctx);
		if (showFullChart) updateFullChart(ctx);
	});
}
