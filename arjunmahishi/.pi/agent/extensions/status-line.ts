/**
 * Status Line Extension — single-line footer compositor
 *
 * Replaces the default multi-line footer with a single-line layout that
 * renders all extension statuses inline alongside model and branch info.
 *
 * Footer example:
 *   ↑12.3k ↓1.2k  …▄▅▆▇█ $0.73 (+$0.09)  📋 PLAN    claude-sonnet (main)
 *   ╰── extension statuses (from setStatus) ──────╯    ╰── built-in data ──╯
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function statusLine(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// Left side: all extension statuses
					const statuses = footerData.getExtensionStatuses();
					const left = statuses.size > 0
						? [...statuses.values()].join("  ")
						: "";

					// Right side: model + branch
					const branch = footerData.getGitBranch();
					const branchStr = branch ? ` (${branch})` : "";
					const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	});
}
