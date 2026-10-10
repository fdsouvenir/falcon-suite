import type { TurnOutcome } from '../store/work.js';

/**
 * What a tool call left outside the chat (spec §10, The record keeper): a commit, a push, a pull
 * request, a release, an install or deploy, a message sent, a file written, a config change or
 * another external write. Everything else — reads, searches, listings, test runs, coordination
 * between sessions — is not an outcome and returns null. Tool names are matched without regard to
 * case, so Claude Code's tools (`Bash`, `Edit`, `Write`…) count like OpenClaw's own.
 *
 * Only recognised changes are outcomes: an unknown command is not one. A missed change costs a
 * line on a timeline; noise costs the person the timeline.
 */

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const RECORDING_TOOLS = /^falcon_work(_plan|_task|_ask|_finding)?$/;
const FILE_TOOLS = new Set([
	'write',
	'edit',
	'multiedit',
	'multi_edit',
	'apply_patch',
	'file_write',
	'notebookedit',
	'notebook_edit'
]);
const SHELL_TOOLS = new Set(['exec', 'bash', 'shell', 'process', 'gateway_exec']);
const MESSAGE_TOOLS = new Set(['message', 'conversations_send', 'conversations_turn', 'tts']);
const CONFIG_TOOLS = new Set(['gateway', 'openclaw', 'plugins', 'automations', 'secrets', 'theme']);
const READ_ACTION =
	/^(get|list|status|runs|read|inspect|search|config\.get|config\.schema\.lookup|group_list|cloud_profiles|emoji-list)$/;
/** MCP and plugin tools whose name says they write. */
const WRITING_NAME =
	/(^|_)(create|update|delete|remove|send|post|set|add|apply|publish|deploy|execute|write|upload|merge|close|comment)(_|$)/;

/** A Code Mode script is a wrapper: the tools it calls report their own after_tool_call events. */
const CODE_MODE_SCRIPT =
	/^\s*(return\s+)?await\s+[a-z_][a-z0-9_]*\s*\(|\breturn\s+await\s+[a-z_][a-z0-9_]*\s*\(|^\s*(const|let|var|for|if|try|text\s*\()[\s\S]*\bawait\s+[A-Za-z_$]/i;

/** Recognised shell changes, first match wins. */
const SHELL: {
	re: RegExp;
	kind: TurnOutcome['kind'];
	label: (m: RegExpMatchArray, c: string) => string;
}[] = [
	{
		re: /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/,
		kind: 'commit',
		label: (_m, c) => {
			const msg = c.match(/\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/);
			return msg ? (msg[1] ?? msg[2] ?? msg[3]).split('\n')[0] : 'Commit';
		}
	},
	{ re: /\bgit\s+push\b/, kind: 'push', label: () => 'Pushed' },
	{ re: /\bgit\s+tag\s+(?!-l\b|--list\b)(\S+)/, kind: 'release', label: (m) => `Tagged ${m[1]}` },
	{
		re: /\bgh\s+pr\s+(create|merge|close|review)\b/,
		kind: 'pr',
		label: (m) => `Pull request ${m[1]}`
	},
	{
		re: /\bgh\s+issue\s+(create|comment|close|edit|reopen)\b(?:\s+(\d+))?/,
		kind: 'message',
		label: (m) => `Issue ${m[1]}${m[2] ? ` #${m[2]}` : ''}`
	},
	{ re: /\bgh\s+release\s+create\s+(\S+)/, kind: 'release', label: (m) => `Release ${m[1]}` },
	{
		re: /\b(npm|pnpm)\s+publish\b|\bclawhub\s+package\s+publish\b/,
		kind: 'release',
		label: () => 'Published a package'
	},
	{
		re: /\bnode\s+\S*stage\.mjs\s+(\S+)\s+(\S+)\s+(\S+)\s+--publish\b/,
		kind: 'release',
		label: (m) => `Published ${m[1]} ${m[3]} (${m[2]})`
	},
	{
		re: /\bopenclaw\s+plugins\s+(install|update|uninstall|enable|disable)\s*(\S*)/,
		kind: 'deploy',
		label: (m) => `Plugin ${m[1]} ${m[2]}`.trim()
	},
	{
		re: /\bopenclaw\s+fleet\s+(create|rm|restart)\s+(\S+)/,
		kind: 'deploy',
		label: (m) => `Office ${m[1]} ${m[2]}`
	},
	{
		re: /\b(podman|docker)\s+(run|rm|restart|stop|start|rmi|pull|build)\b/,
		kind: 'deploy',
		label: (m) => `${m[1]} ${m[2]}`
	},
	{
		re: /\bsystemctl\s+(?:--user\s+)?(start|stop|restart|reload|enable|disable)\s+(\S+)/,
		kind: 'deploy',
		label: (m) => `${m[1]} ${m[2]}`
	},
	{
		re: /\b(kubectl\s+(apply|delete)|terraform\s+apply|wrangler\s+deploy|flyctl\s+deploy)\b/,
		kind: 'deploy',
		label: (m) => m[1]
	},
	{
		re: /\b(apt(-get)?|dnf|brew)\s+(install|remove|upgrade)\b|\bnpm\s+(i|install)\s+-g\b/,
		kind: 'deploy',
		label: () => 'Installed software'
	},
	{
		re: /\bopenclaw\s+(config\s+(set|unset)|secrets\s+store\s+(set|rm))\s+(\S+)/,
		kind: 'config',
		label: (m) => `${m[1]} ${m[4]}`
	},
	{ re: /\bcrontab\s+(?!-l\b)/, kind: 'config', label: () => 'Changed a crontab' },
	{
		re: /\bcurl\b[^|;]*\s-X\s*(POST|PUT|PATCH|DELETE)\b|\bgh\s+api\b[^|;]*-X\s*(POST|PUT|PATCH|DELETE)\b/,
		kind: 'change',
		label: (m) => `API ${m[1] ?? m[2]}`
	},
	{ re: /\bsed\s+-i\S*\s.*?(\S+)\s*$/, kind: 'file', label: (m) => m[1] },
	{ re: /\btee\s+(?:-a\s+)?(?!\/dev\/|\/tmp\/)(\S+)/, kind: 'file', label: (m) => m[1] },
	{
		re: /(?:^|[^>&0-9])>{1,2}\s*(?!\/dev\/|\/tmp\/|&)([~./\w][^\s;|&]*)/,
		kind: 'file',
		label: (m) => m[1]
	},
	{
		re: /\b(rm|mv)\s+(?:-\S+\s+)*(?!\/tmp\/|-)(\S+)/,
		kind: 'change',
		label: (m) => `${m[1]} ${m[2]}`
	}
];

/** `ssh host 'cmd'` and `podman exec c cmd` run the inner command elsewhere: classify that. */
function inner(command: string): string {
	return command
		.replace(/\bssh\s+(?:-\S+\s+)*\S+\s+/g, ' ')
		.replace(/\b(podman|docker)\s+exec\s+(?:-\S+\s+)*\S+\s+/g, ' ');
}

/** Commit hash from `git commit` output, e.g. `[main 4fdd0ff] message`. */
function commitRef(result: unknown): string | undefined {
	const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
	return text.match(/\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/)?.[1];
}

export function outcome(
	toolName: string,
	params: Record<string, unknown>,
	opts: { error?: string; toolKind?: string; result?: unknown } = {}
): TurnOutcome | null {
	if (opts.error) return null; // a failed call is taken to have changed nothing
	const name = toolName.toLowerCase();
	if (
		opts.toolKind === 'code_mode_exec' ||
		((typeof params.script === 'string' || typeof params.code === 'string') &&
			params.command === undefined)
	)
		return null;
	if (RECORDING_TOOLS.test(name) || name === 'falcon_work_read') return null;

	if (SHELL_TOOLS.has(name)) {
		const command = str(params.command) || str(params.cmd) || str(params.script);
		if (!command || CODE_MODE_SCRIPT.test(command)) return null;
		const c = inner(command);
		for (const rule of SHELL) {
			const m = c.match(rule.re);
			if (!m) continue;
			const ref = rule.kind === 'commit' ? commitRef(opts.result) : undefined;
			return { kind: rule.kind, label: clip(rule.label(m, c)), ...(ref ? { ref } : {}) };
		}
		return null;
	}
	if (FILE_TOOLS.has(name)) {
		const path =
			str(params.path) ||
			str(params.file_path) ||
			str(params.filePath) ||
			str(params.notebook_path);
		return path ? { kind: 'file', label: path, ref: path } : null;
	}
	if (MESSAGE_TOOLS.has(name)) {
		if (name === 'message' && READ_ACTION.test(str(params.action))) return null;
		const to = str(params.target) || str(params.conversationRef) || str(params.channel);
		return { kind: 'message', label: clip(`Message${to ? ` to ${to}` : ''}`) };
	}
	if (CONFIG_TOOLS.has(name)) {
		const action = str(params.action);
		if (!action || READ_ACTION.test(action)) return null;
		return { kind: 'config', label: clip(`${name} ${action}`) };
	}
	// MCP tools arrive prefixed (mcp__server__tool): judge the tool's own name.
	const base = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
	if (base === 'home_assistant_execute')
		return { kind: 'change', label: clip(`Home Assistant ${str(params.action)}`) };
	if (
		WRITING_NAME.test(base) &&
		!RECORDING_TOOLS.test(base) &&
		!/^(sessions|subagents|agents)_/.test(base)
	)
		return { kind: 'change', label: clip(base) };
	return null;
}

/** Did this call raise a Question or Decision (directly, or from inside a Code Mode script)? */
export function raisesAsk(toolName: string, params: Record<string, unknown>): boolean {
	const name = toolName.toLowerCase().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
	if (name === 'falcon_work_ask') return true;
	if (name === 'falcon_work')
		return ['raise_question', 'raise_decision', 'add_hypothesis'].includes(str(params.command));
	const script = str(params.code) || str(params.script) || str(params.command);
	return /falcon_work_ask\s*\(|['"](raise_question|raise_decision)['"]/.test(script);
}

/** Did this call record or correct Work itself? Then the agent's record wins for that turn. */
export function recordsWork(toolName: string): boolean {
	const name = toolName.toLowerCase().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
	return RECORDING_TOOLS.test(name);
}
