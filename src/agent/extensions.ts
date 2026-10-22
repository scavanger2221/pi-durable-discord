import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { DeliverTask } from "../discord/deliver.ts";
import { safeName } from "../discord/content.ts";
import { Outbox, ThreadInfo } from "../discord/docs.ts";
import type { DiscordPort } from "../discord/port.ts";

const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE|AUTH)/i;
const SAFE_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TERM", "TZ", "SHELL", "TMPDIR"]);
const SAFE_PREFIXES = ["LC_", "XDG_", "NODE_", "npm_config_", "NVM_", "BUN_", "UV_", "PYTHON", "GIT_AUTHOR_", "GIT_COMMITTER_"];

/** The environment the agent's bash gets: an allowlist of harmless variables, never the bot token or a provider key. */
export function buildSafeEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined || SECRET.test(name)) continue;
		if (SAFE_NAMES.has(name) || SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = value;
	}
	env.TERM ??= "dumb";
	env.GIT_PAGER = "cat";
	env.PAGER = "cat";
	return env;
}

/** pi's coding tools (read, write, edit, bash), with a bash that inherits nothing from the service's environment. */
export function createWorkspaceTools(env: Readonly<Record<string, string>>): Extension {
	const bash = createBashTool({
		prepare: (execution) => {
			execution.inheritEnv = false;
			execution.env = { ...env };
		},
	});
	return defineExtension({
		name: "workspace",
		tools: [createReadTool(), createWriteTool(), createEditTool(), bash].map((tool) => tool as unknown as ToolRegistration),
	});
}

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

/** Reads a file per request, re-reading only when its mtime or size changed; "none" when it is missing. */
function cachedFile(path: string): () => Promise<string> {
	let cached: { mtimeMs: number; size: number; text: string } | undefined;
	return async () => {
		const info = await stat(path).catch(() => undefined);
		if (info === undefined || !info.isFile()) return "none";
		if (cached?.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
			const bytes = await readFile(path).catch(() => Buffer.from("none (unreadable)"));
			const text = bytes.subarray(0, MAX_INSTRUCTIONS_BYTES).toString("utf8").trim();
			cached = { mtimeMs: info.mtimeMs, size: info.size, text };
		}
		return cached.text;
	};
}

export const PREAMBLE = [
	"You are pi, a coding agent. People talk to you in a Discord server. Every task runs in its own Discord thread, and this conversation is one of them.",
	"Several people may post in the thread. Each user message starts with a line naming its author, like `[discord] @name (id 123):`; address people by name when it matters.",
	"You have read, write, edit and bash tools with full access to your working directory. Files people attach are saved under inbox/ there; the message tells you the path. View images with the read tool.",
	"To show people a file, such as an image you made (a chart, a diagram, a screenshot), use discord_send_file: it is attached to your answer message, which Discord shows after your text. Pass now=true only to show something before you finish, like a progress screenshot.",
	"Answers are shown in Discord: use Markdown (bold, italic, code, code blocks, lists, headings, links). Tables do not render; use lists or code blocks instead. Keep answers compact.",
	"A tool call interrupted by a restart may already have taken effect: check the current state before repeating it.",
].join("\n");

/**
 * The system prompt: a constant preamble, the working directory, and pi's global and project AGENTS.md. Every
 * section is always present (a missing file renders "none"), so the provider prompt cache stays warm.
 */
export function createPromptExtension(options: { globalInstructions: string; projectInstructions: string }): Extension {
	const global = cachedFile(options.globalInstructions);
	const project = cachedFile(options.projectInstructions);
	return defineExtension({
		name: "prompt",
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("cwd", (input) => input.agent.cwd ?? input.env?.cwd),
			section("global_instructions", async () => global()),
			section("project_instructions", async () => project()),
		],
	});
}

const UPLOAD_LIMIT = 10 * 1024 * 1024;

/**
 * The channel's durable part: the delivery task definition and the `discord_send_file` tool. By default the tool copies
 * the file to `outboxDir` and records it in the conversation's Outbox, and delivery attaches it to the run's answer.
 */
export function createDiscordExtension(options: { deliver: DeliverTask; port: () => DiscordPort; outboxDir: string }): Extension {
	const sendFile = defineTool({
		name: "discord_send_file",
		description:
			"Attach a file from the working directory (at most 10 MB) to your answer in this task's Discord thread. Images show inline.",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory" }),
			now: Type.Optional(Type.Boolean({ description: "Post it right away as its own message instead of with the answer" })),
			caption: Type.Optional(Type.String({ description: "With now=true: a short message shown with the file" })),
		}),
		execute: async (args, api, context) => {
			const info = await api.snapshot(ThreadInfo, api.conversationId, context);
			if (info === undefined || info.threadId === "") throw new Error("This conversation has no Discord thread");
			const cwd = (await api.agent(context)).cwd ?? process.cwd();
			const path = resolve(cwd, args.path);
			const inside = relative(cwd, path);
			if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("The file must be inside the working directory");
			const size = (await stat(path)).size;
			if (size > UPLOAD_LIMIT) throw new Error(`The file is ${Math.round(size / 1024 / 1024)} MB; the limit is 10 MB`);
			const name = basename(path);
			if (args.now === true) {
				await options.port().send(info.threadId, args.caption ?? "", { files: [{ path, name }] });
				return { output: [{ type: "text", text: `Sent ${args.path} to the thread.` }] };
			}
			// A copy, so the answer carries the file as it is now even if the agent changes or deletes it later.
			await mkdir(options.outboxDir, { recursive: true });
			const copy = join(options.outboxDir, `${api.taskId}-${safeName(name)}`);
			await copyFile(path, copy);
			await api.commit(async (tx) => {
				const outbox = await tx.doc(Outbox, api.conversationId);
				outbox.files.push({ path: copy, name });
			}, context);
			return { output: [{ type: "text", text: `Attached ${args.path}; it is posted with your answer.` }] };
		},
	});
	return defineExtension({
		name: "discord",
		tasks: [options.deliver],
		tools: [sendFile as unknown as ToolRegistration],
	});
}
