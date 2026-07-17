#!/usr/bin/env node
/**
 * SessionStart hook — surface open TODO items into session context.
 *
 * Why this exists: "read TODO.md at session start" written in CLAUDE.md is a
 * convention, not a mechanism — it works only if a session happens to follow it.
 * Printing open items to stdout at SessionStart puts them in context whether or
 * not anyone remembers to look. That is the difference between a documented
 * intention and a system.
 *
 * Contract: SessionStart hooks inject stdout into the session's context
 * (same pattern as session-memory.mjs). Always exit 0 — a hook that fails must
 * never block a session from starting.
 *
 * Reads:  $CLAUDE_PROJECT_DIR/TODO.md  (workspace-level, sectioned by active area)
 * Prints: unchecked `- [ ]` items grouped under their `## Section` heading.
 *
 * Deliberately does NOT print:
 *   - completed items (`- [x]`) — noise; the point is what's still open
 *   - "Settled — don't re-litigate" blocks — those are reference, read on demand.
 *     Surfacing them every session would bury the actionable items.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_ITEMS = 12; // keep the injection small; TODO.md is one Read away
const MAX_LEN = 150; // per item; enough to carry the "why", not the whole entry
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const todoPath = join(projectDir, 'TODO.md');

if (!existsSync(todoPath)) process.exit(0);

try {
	const lines = readFileSync(todoPath, 'utf8').split(/\r?\n/);

	let section = null;
	let inSettled = false;
	const bySection = new Map();

	for (const line of lines) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			section = heading[1];
			inSettled = false;
			continue;
		}

		// "Settled — don't re-litigate:" blocks run until the next ## heading.
		if (/^\*\*Settled/i.test(line)) {
			inSettled = true;
			continue;
		}
		if (inSettled) continue;

		const open = line.match(/^\s*-\s*\[ \]\s*(.+?)\s*$/);
		if (open && section) {
			if (!bySection.has(section)) bySection.set(section, []);
			// Strip markdown emphasis so the injected text reads cleanly.
			const text = open[1].replace(/\*\*/g, '').trim();
			bySection.get(section).push({ text, cont: [] });
			continue;
		}

		// Continuation lines: an item's detail wraps across indented lines until the
		// next item or heading. Keep them so the "why" survives, not just the label.
		if (section && bySection.has(section) && /^\s{4,}\S/.test(line)) {
			const items = bySection.get(section);
			if (items.length) items[items.length - 1].cont.push(line.trim());
		}
	}

	const total = [...bySection.values()].reduce((n, v) => n + v.length, 0);
	if (total === 0) process.exit(0);

	// Name the scope so a project session doesn't think it's reading the workspace list.
	const scope = basename(projectDir);
	const out = [`Open TODO items (${total}) — from ${scope}/TODO.md:`];
	let printed = 0;

	for (const [sec, items] of bySection) {
		if (printed >= MAX_ITEMS) break;
		out.push(`\n${sec}:`);
		for (const item of items) {
			if (printed >= MAX_ITEMS) break;
			// Keep the label AND the start of its rationale — a bare label ("Sergey's
			// MacBook Pro") tells a future session nothing about why it's on the list.
			// Truncate on a word boundary: splitting on '.' breaks abbreviations
			// ("vs.", "e.g."), and splitting on the em-dash drops the why entirely.
			// Strip emphasis AFTER joining — continuation lines carry markdown too.
			const full = [item.text, ...item.cont]
				.join(' ')
				.replace(/\*\*/g, '')
				.replace(/\s+/g, ' ')
				.trim();
			let short = full;
			if (full.length > MAX_LEN) {
				const cut = full.slice(0, MAX_LEN);
				const sp = cut.lastIndexOf(' ');
				short = (sp > MAX_LEN * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:—-]$/, '') + '…';
			}
			out.push(`  - ${short}`);
			printed++;
		}
	}

	if (total > printed) {
		out.push(`\n(+${total - printed} more — read TODO.md for full detail and the`);
		out.push(`"Settled — don't re-litigate" blocks before re-opening closed questions.)`);
	} else {
		out.push(`\nRead TODO.md for full detail. Each section has a "Settled — don't`);
		out.push(`re-litigate" block — check it before re-opening a closed question.`);
	}

	console.log(out.join('\n'));
} catch {
	// Never block session start on a TODO parse failure.
}

process.exit(0);
