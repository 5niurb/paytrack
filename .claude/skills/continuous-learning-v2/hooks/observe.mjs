#!/usr/bin/env node
/**
 * Continuous Learning v2 — Observation Hook (Node.js port)
 *
 * Captures tool use events with structured metadata for pattern analysis.
 * Extracts file paths, error signals, command types, and search patterns
 * so instinct extraction can identify behavioral patterns — not just tool counts.
 *
 * Hook config (in .claude/settings.json):
 * {
 *   "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command",
 *     "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/continuous-learning-v2/hooks/observe.mjs\" pre" }] }],
 *   "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command",
 *     "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/continuous-learning-v2/hooks/observe.mjs\" post" }] }]
 * }
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, extname } from 'path';

const CONFIG_DIR = join(homedir(), '.claude', 'homunculus');
const OBSERVATIONS_FILE = join(CONFIG_DIR, 'observations.jsonl');
const MAX_FILE_SIZE_MB = 10;

mkdirSync(CONFIG_DIR, { recursive: true });

if (existsSync(join(CONFIG_DIR, 'disabled'))) process.exit(0);

let inputJson = '';
try {
	inputJson = readFileSync(0, 'utf8').trim();
} catch {
	process.exit(0);
}

if (!inputJson) process.exit(0);

/**
 * Extract structured metadata from tool input/output.
 * Returns a compact object with only the fields that matter for pattern detection.
 */
function extractMeta(toolName, toolInput, toolOutput, event) {
	const meta = {};
	const input = typeof toolInput === 'object' ? toolInput : {};
	const outputStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput || '');

	// File path extraction — the most important signal for correlating tool sequences
	const filePath = input.file_path || input.path || input.file || null;
	if (filePath) {
		meta.file = filePath;
		const ext = extname(filePath);
		if (ext) meta.ext = ext;
	}

	// Tool-specific metadata
	switch (toolName) {
		case 'Bash': {
			const cmd = input.command || '';
			// Extract the base command (first word before pipes/args)
			const baseCmd = cmd.split(/[\s|;&]/)[0].replace(/^.*\//, '');
			if (baseCmd) meta.cmd = baseCmd;
			// Flag git operations
			if (cmd.startsWith('git ')) meta.git_op = cmd.split(/\s+/)[1]; // push, commit, add, etc.
			// Flag npm/node operations
			if (baseCmd === 'npm' || baseCmd === 'npx' || baseCmd === 'node') {
				meta.node_op = cmd.split(/\s+/).slice(0, 3).join(' ');
			}
			break;
		}
		case 'Edit': {
			if (input.old_string && input.new_string) {
				meta.edit_size = Math.abs(input.new_string.length - input.old_string.length);
				meta.replace_all = input.replace_all || false;
			}
			break;
		}
		case 'Grep': {
			if (input.pattern) meta.search = input.pattern.slice(0, 100);
			if (input.glob) meta.glob = input.glob;
			break;
		}
		case 'Glob': {
			if (input.pattern) meta.pattern = input.pattern.slice(0, 100);
			break;
		}
		case 'Task': {
			if (input.subagent_type) meta.agent = input.subagent_type;
			if (input.model) meta.model = input.model;
			if (input.description) meta.desc = input.description.slice(0, 80);
			break;
		}
		case 'Write': {
			if (input.content) meta.write_size = input.content.length;
			break;
		}
	}

	// Error detection from output (PostToolUse only)
	if (event === 'tool_complete' && outputStr) {
		const lower = outputStr.slice(0, 2000).toLowerCase();
		if (
			lower.includes('error') ||
			lower.includes('failed') ||
			lower.includes('exception') ||
			lower.includes('enoent') ||
			lower.includes('permission denied') ||
			lower.includes('not found')
		) {
			meta.has_error = true;
			// Extract first error-like line for context
			const errorLine = outputStr
				.split('\n')
				.find(
					(l) =>
						/error|failed|exception|enoent|permission denied|not found/i.test(l) && l.trim().length > 5,
				);
			if (errorLine) meta.error_hint = errorLine.trim().slice(0, 200);
		}
	}

	return Object.keys(meta).length > 0 ? meta : undefined;
}

let observation;
try {
	const data = JSON.parse(inputJson);

	const hookType = data.hook_type || 'unknown';
	const toolName = data.tool_name || data.tool || 'unknown';
	const toolInput = data.tool_input || data.input || {};
	const toolOutput = data.tool_output || data.output || '';
	const sessionId = data.session_id || 'unknown';
	const event = hookType.includes('Pre') ? 'tool_start' : 'tool_complete';

	observation = {
		timestamp: new Date().toISOString(),
		event,
		tool: toolName,
		session: sessionId,
	};

	// Extract structured metadata instead of dumping raw input/output
	const meta = extractMeta(toolName, toolInput, toolOutput, event);
	if (meta) observation.meta = meta;
} catch (e) {
	const timestamp = new Date().toISOString();
	const errorEntry = JSON.stringify({ timestamp, event: 'parse_error', raw: inputJson.slice(0, 2000) });
	appendFileSync(OBSERVATIONS_FILE, errorEntry + '\n');
	process.exit(0);
}

// Archive if file too large
if (existsSync(OBSERVATIONS_FILE)) {
	try {
		const stats = statSync(OBSERVATIONS_FILE);
		if (stats.size / (1024 * 1024) >= MAX_FILE_SIZE_MB) {
			const archiveDir = join(CONFIG_DIR, 'observations.archive');
			mkdirSync(archiveDir, { recursive: true });
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			renameSync(OBSERVATIONS_FILE, join(archiveDir, `observations-${ts}.jsonl`));
		}
	} catch {
		/* ignore stat/rename errors */
	}
}

appendFileSync(OBSERVATIONS_FILE, JSON.stringify(observation) + '\n');
