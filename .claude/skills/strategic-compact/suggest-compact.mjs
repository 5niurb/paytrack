#!/usr/bin/env node
/**
 * Strategic Compact Suggester — Phase-Aware
 *
 * Runs on PreToolUse (Edit/Write) and suggests /compact at logical phase transitions.
 * Instead of just counting tool calls, it reads recent observations to detect:
 *
 * 1. Research → Implementation transition (many Reads/Greps followed by first Edit)
 * 2. Debugging → Next feature (error patterns followed by unrelated edits)
 * 3. High tool count milestones (50, then every 25)
 * 4. Long research bursts (20+ Reads without an Edit — context getting bloated)
 *
 * Uses observations.jsonl from the continuous-learning observe hook.
 *
 * Hook config:
 * { "matcher": "Edit|Write", "hooks": [{ "type": "command",
 *   "command": "node \"path/to/suggest-compact.mjs\"" }] }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const sessionId = process.env.CLAUDE_SESSION_ID || process.env.PPID || 'default';
const stateFile = join(tmpdir(), `claude-compact-state-${sessionId}`);
const obsFile = join(homedir(), '.claude', 'homunculus', 'observations.jsonl');

// Load or init state
let state = { count: 0, lastSuggestion: 0, lastPhase: 'unknown', suggestedAt: [] };
if (existsSync(stateFile)) {
	try {
		state = JSON.parse(readFileSync(stateFile, 'utf8'));
	} catch {
		/* reset on corrupt state */
	}
}

state.count++;

// Read recent observations (last 80 lines — cheap tail read)
let recentTools = [];
if (existsSync(obsFile)) {
	try {
		const lines = readFileSync(obsFile, 'utf8').trim().split('\n');
		const tail = lines.slice(-80);
		recentTools = tail
			.map((l) => {
				try {
					const o = JSON.parse(l);
					// Only look at current session
					if (o.session !== sessionId && sessionId !== 'default') return null;
					return { tool: o.tool, event: o.event, meta: o.meta, ts: o.timestamp };
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		/* observations not available — fall back to count-only mode */
	}
}

// Phase detection from recent tool sequence
function detectPhase(tools) {
	if (tools.length < 5) return 'unknown';

	const last20 = tools.slice(-20).map((t) => t.tool);
	const readCount = last20.filter((t) => t === 'Read').length;
	const grepCount = last20.filter((t) => t === 'Grep' || t === 'Glob').length;
	const editCount = last20.filter((t) => t === 'Edit' || t === 'Write').length;
	const bashCount = last20.filter((t) => t === 'Bash').length;
	const searchCount = last20.filter((t) => t === 'WebSearch' || t === 'WebFetch').length;
	const taskCount = last20.filter((t) => t === 'Task').length;

	// Heavy research: mostly reads/greps/searches, few edits
	if (readCount + grepCount + searchCount >= 14 && editCount <= 2) return 'research';

	// Implementation: mostly edits with some reads
	if (editCount >= 6) return 'implementation';

	// Testing/verification: bash-heavy (running tests, builds, curls)
	if (bashCount >= 8) return 'testing';

	// Debugging: mix of reads + bash with errors
	const hasErrors = tools.slice(-20).some((t) => t.meta?.has_error);
	if (hasErrors && readCount >= 4 && bashCount >= 3) return 'debugging';

	// Exploration: subagent-heavy
	if (taskCount >= 3) return 'exploration';

	return 'mixed';
}

// Check for long unbroken read streaks (context bloat signal)
function readStreakLength(tools) {
	let streak = 0;
	for (let i = tools.length - 1; i >= 0; i--) {
		const t = tools[i].tool;
		if (t === 'Read' || t === 'Grep' || t === 'Glob' || t === 'WebSearch' || t === 'WebFetch') {
			streak++;
		} else if (t === 'Edit' || t === 'Write') {
			break; // streak broken by an edit
		}
		// Skip other tools (ToolSearch, etc.) — don't break streak
	}
	return streak;
}

const currentPhase = detectPhase(recentTools);
const previousPhase = state.lastPhase;
const sinceLastSuggestion = state.count - state.lastSuggestion;

let suggestion = null;

// Phase transition detection
if (previousPhase !== 'unknown' && currentPhase !== previousPhase && sinceLastSuggestion >= 15) {
	const transitions = {
		'research→implementation':
			'Research phase complete, starting implementation. Good time for /compact — plan is formed, research context is bulky.',
		'research→mixed':
			'Transitioning from research. Consider /compact to clear exploration context before building.',
		'debugging→implementation':
			'Debug resolved, back to building. /compact clears dead-end reasoning and error traces.',
		'debugging→mixed':
			'Debug phase ended. Consider /compact to clear error context before moving on.',
		'testing→implementation':
			'Tests done, more implementation ahead. /compact if the test context is no longer needed.',
		'exploration→implementation':
			'Exploration complete, starting implementation. /compact frees context for focused coding.',
	};

	const key = `${previousPhase}→${currentPhase}`;
	if (transitions[key]) {
		suggestion = `[StrategicCompact] Phase transition: ${key}. ${transitions[key]}`;
	}
}

// Read streak detection (context bloat)
if (!suggestion && sinceLastSuggestion >= 15) {
	const streak = readStreakLength(recentTools);
	if (streak >= 25) {
		suggestion = `[StrategicCompact] ${streak} consecutive read/search operations — context is likely bloated with file contents. Consider /compact before editing.`;
	}
}

// Fallback: count-based milestones (original behavior)
const threshold = parseInt(process.env.COMPACT_THRESHOLD || '50', 10);
if (!suggestion) {
	if (state.count === threshold) {
		suggestion = `[StrategicCompact] ${threshold} tool calls reached. Consider /compact if you're between tasks.`;
	} else if (state.count > threshold && state.count % 25 === 0) {
		suggestion = `[StrategicCompact] ${state.count} tool calls. Good checkpoint for /compact if context feels stale.`;
	}
}

// Output suggestion
if (suggestion) {
	console.error(suggestion);
	state.lastSuggestion = state.count;
	state.suggestedAt.push({ count: state.count, phase: currentPhase, ts: new Date().toISOString() });
	// Keep only last 10 suggestions in state
	if (state.suggestedAt.length > 10) state.suggestedAt = state.suggestedAt.slice(-10);
}

state.lastPhase = currentPhase;
writeFileSync(stateFile, JSON.stringify(state));
