import type { ActivityKind } from '../store/work.js';

/**
 * Decide whether a tool call changed something (spec §10: "what counts as work") and, if so,
 * summarise it. Read-only calls return null. OpenClaw does not mark tools read-only, so this is a
 * name- and command-based classification; unknown tools are treated as changes, because a missed
 * change is worse than an extra line of activity.
 */
export type Classified = { kind: ActivityKind; summary: string; ref?: string } | null;

const READ_ONLY_TOOLS = new Set([
	'read',
	'view_image',
	'web_search',
	'web_fetch',
	'memory_search',
	'memory_get',
	'sessions_list',
	'sessions_history',
	'sessions_search',
	'session_status',
	'subagents',
	'agents_list',
	'agents_wait',
	'conversations_list',
	'presence',
	'get_goal',
	'pdf',
	'falcon_work_read',
	// Session presentation, not work.
	'progress_card',
	'sessions_yield'
]);
const READ_ONLY_SUFFIX =
	/(^|_)(read|get|list|search|fetch|status|history|view|inspect|find|stats|runs|brief|describe|events)$/;
const RECORDING_TOOLS = new Set([
	'falcon_work',
	'falcon_work_plan',
	'falcon_work_task',
	'falcon_work_ask',
	'falcon_work_finding'
]);

const READ_ONLY_COMMAND =
	/^\s*(ls|cat|head|tail|less|grep|rg|ugrep|find|fd|wc|stat|file|du|df|pwd|echo|printf|which|type|env|date|whoami|id|uname|ps|top|free|uptime|tree|jq|sort|uniq|cut|diff|cmp|sha256sum|md5sum|curl\s+-s?I|git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|grep|blame|describe|fetch)|gh\s+\S+\s+(view|list|status|diff|checks|watch)|gh\s+api\s+(?!.*-X\s*(POST|PATCH|PUT|DELETE))|npm\s+(ls|view|outdated|audit)|systemctl\s+(status|is-active|list-units|show)|journalctl|docker\s+(ps|logs|inspect|images)|kubectl\s+(get|describe|logs)|sqlite3\s+\S+\s+["']?select|openclaw\s+(status|--version|plugins\s+(list|inspect|validate))|clawhub\s+(whoami|inspect|search|explore))\b/i;

/** Code Mode scripts are JavaScript that calls tools, e.g. `return await read({...})` or `const r = await t({...})`. */
const CODE_MODE_SCRIPT =
	/^\s*(return\s+)?await\s+[a-z_][a-z0-9_]*\s*\(|\breturn\s+await\s+[a-z_][a-z0-9_]*\s*\(|^\s*(const|let|var|for|if|try|text\s*\()[\s\S]*\bawait\s+[A-Za-z_$]/i;

const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function classify(
	toolName: string,
	params: Record<string, unknown>,
	error?: string,
	toolKind?: string
): Classified {
	if (error) return null; // a failed call is taken to have changed nothing
	// A code-mode script is a wrapper: the tools it calls report their own after_tool_call events.
	// Hosts that do not label it (2026.9.6) still pass a `script` rather than a shell `command`.
	// Hosts pass the script as `code` (2026.9.6 Code Mode) or `script`, never as a shell `command`.
	if (
		toolKind === 'code_mode_exec' ||
		((typeof params.script === 'string' || typeof params.code === 'string') &&
			params.command === undefined)
	)
		return null;
	if (toolName === 'exec' && CODE_MODE_SCRIPT.test(str(params.command))) return null;
	if (RECORDING_TOOLS.has(toolName)) return null;
	if (READ_ONLY_TOOLS.has(toolName)) return null;

	if (['exec', 'bash', 'shell', 'process', 'gateway_exec'].includes(toolName)) {
		const command = str(params.command) || str(params.cmd) || str(params.script);
		if (!command) return null;
		// A pipeline or chain is read-only only if every part is.
		const parts = command
			.split(/&&|\|\||;|\|/)
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length && parts.every((p) => READ_ONLY_COMMAND.test(p))) return null;
		if (/\bgit\s+(commit|push|tag)\b/.test(command))
			return { kind: 'commit', summary: clip(command) };
		if (
			/\b(npm|pnpm)\s+publish\b|\bclawhub\s+package\s+publish\b|\bgh\s+release\s+create\b/.test(
				command
			)
		)
			return { kind: 'release', summary: clip(command) };
		return { kind: 'command', summary: clip(command) };
	}
	if (
		['write', 'edit', 'apply_patch', 'multi_edit', 'file_write', 'notebook_edit'].includes(toolName)
	) {
		const path = str(params.path) || str(params.file_path) || str(params.filePath);
		return { kind: 'file', summary: `${toolName} ${path}`.trim(), ...(path ? { ref: path } : {}) };
	}
	if (
		['message', 'sessions_send', 'conversations_send', 'conversations_turn', 'tts'].includes(
			toolName
		)
	) {
		if (toolName === 'message' && ['read', 'emoji-list'].includes(str(params.action))) return null;
		const to =
			str(params.target) ||
			str(params.sessionKey) ||
			str(params.conversationRef) ||
			str(params.channel);
		return {
			kind: 'message',
			summary: clip(
				`${toolName}${params.action ? ' ' + str(params.action) : ''}${to ? ' → ' + to : ''}`
			)
		};
	}
	if (
		['gateway', 'openclaw', 'plugins', 'automations', 'secrets', 'sessions', 'theme'].includes(
			toolName
		)
	) {
		const action = str(params.action);
		if (
			/^(get|list|status|runs|read|inspect|search|config\.get|config\.schema\.lookup|group_list|cloud_profiles)$/.test(
				action
			)
		)
			return null;
		return { kind: 'config', summary: clip(`${toolName} ${action}`.trim()) };
	}
	if (toolName === 'browser') {
		const action = str(params.action);
		if (action !== 'act' && action !== 'upload' && action !== 'dialog') return null;
		return {
			kind: 'api',
			summary: clip(
				`browser ${action} ${str((params.request as Record<string, unknown>)?.kind) || str(params.kind)}`.trim()
			)
		};
	}
	if (READ_ONLY_SUFFIX.test(toolName)) return null;
	return {
		kind: 'api',
		summary: clip(`${toolName}${params.action ? ' ' + str(params.action) : ''}`)
	};
}
