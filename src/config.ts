import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

type Env = Readonly<Record<string, string | undefined>>;

export type WorkspaceMode = "per-thread" | "shared";

export type Config = {
	readonly discordToken: string;
	/** Discord user ids allowed to prompt. Empty: everyone who can see an allowed channel. */
	readonly allowedUserIds: ReadonlySet<string>;
	/** Discord role ids allowed to prompt, in addition to `allowedUserIds`. */
	readonly allowedRoleIds: ReadonlySet<string>;
	/** Channels where a mention or /pi starts a task. Empty: every channel the bot can see. */
	readonly channelIds: ReadonlySet<string>;
	/** Guilds to register slash commands in at once; global registration otherwise (can take up to an hour). */
	readonly guildIds: readonly string[];
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Root of the agent's files. Per-thread mode gives each task `<workdir>/<threadId>`. */
	readonly workdir: string;
	readonly workspaceMode: WorkspaceMode;
	/** SQLite database and logs. */
	readonly dataDir: string;
	/** pi's agent directory (`~/.pi/agent`): auth.json, settings.json, AGENTS.md. */
	readonly piAgentDir: string;
	readonly authFile: string;
	/** Project instructions read per request; defaults to `<workdir>/AGENTS.md`. */
	readonly instructionsPath: string;
	/** Upper bound for attachments saved to the task workspace. */
	readonly maxAttachmentBytes: number;
	/** An `mcpServers` JSON file (default pi's `mcp.json`); undefined when MCP is turned off. */
	readonly mcpConfigPath: string | undefined;
	/** Offer the `codemode` tool: model-written JavaScript that calls the other tools in a sandbox. */
	readonly codemode: boolean;
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
	const home = env.HOME?.trim() || homedir();
	const piAgentDir = piAgentDirOf(env, home);
	const pi = piDefaults(piAgentDir);
	const discordToken = required(env, "DISCORD_TOKEN");
	const provider = text(env.PI_PROVIDER) ?? pi.provider;
	if (provider === undefined) throw new ConfigError("PI_PROVIDER is not set and pi's settings.json has no defaultProvider");
	// pi's model only means something for pi's provider.
	const modelId = text(env.PI_MODEL) ?? (provider === pi.provider ? pi.model : undefined);
	if (modelId === undefined) throw new ConfigError("PI_MODEL is not set");
	const thinking = text(env.PI_THINKING) ?? pi.thinking ?? "medium";
	if (!THINKING_LEVELS.has(thinking)) throw new ConfigError(`PI_THINKING: unknown level ${JSON.stringify(thinking)}`);
	const workdir = resolve(cwd, text(env.PI_WORKDIR) ?? "workspace");
	const mcp = text(env.PI_MCP_CONFIG);
	const mode = text(env.PI_WORKSPACE_MODE) ?? "per-thread";
	if (mode !== "per-thread" && mode !== "shared") {
		throw new ConfigError(`PI_WORKSPACE_MODE: expected per-thread or shared, got ${JSON.stringify(mode)}`);
	}
	return {
		discordToken,
		allowedUserIds: idSet(env.DISCORD_ALLOWED_USERS),
		allowedRoleIds: idSet(env.DISCORD_ALLOWED_ROLES),
		channelIds: idSet(env.DISCORD_CHANNELS),
		guildIds: [...idSet(env.DISCORD_GUILDS)],
		provider,
		modelId,
		thinkingLevel: thinking as ModelThinkingLevel,
		workdir,
		workspaceMode: mode,
		dataDir: resolve(cwd, text(env.PI_DATA_DIR) ?? "data"),
		piAgentDir,
		authFile: resolve(cwd, text(env.PI_AUTH_FILE) ?? join(piAgentDir, "auth.json")),
		instructionsPath: resolve(cwd, text(env.PI_INSTRUCTIONS) ?? join(workdir, "AGENTS.md")),
		maxAttachmentBytes: Number(text(env.DISCORD_MAX_ATTACHMENT_MB) ?? "25") * 1024 * 1024,
		mcpConfigPath: mcp === "none" ? undefined : resolve(cwd, mcp ?? join(piAgentDir, "mcp.json")),
		codemode: !["0", "off", "false"].includes(text(env.PI_CODEMODE)?.toLowerCase() ?? ""),
	};
}

/** pi's agent directory: `PI_CODING_AGENT_DIR` (with `~` expanded), else `~/.pi/agent`, the same rule pi uses. */
function piAgentDirOf(env: Env, home: string): string {
	const fromEnv = text(env.PI_CODING_AGENT_DIR);
	if (fromEnv === undefined) return join(home, ".pi", "agent");
	if (fromEnv === "~") return home;
	if (fromEnv.startsWith("~/")) return join(home, fromEnv.slice(2));
	return resolve(fromEnv);
}

function piDefaults(agentDir: string): { provider?: string; model?: string; thinking?: string } {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
	const pick = (key: string) => (typeof settings[key] === "string" ? text(settings[key] as string) : undefined);
	return { provider: pick("defaultProvider"), model: pick("defaultModel"), thinking: pick("defaultThinkingLevel") };
}

function required(env: Env, name: string): string {
	const value = text(env[name]);
	if (value === undefined) throw new ConfigError(`${name} is required`);
	return value;
}

function text(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function idSet(value: string | undefined): ReadonlySet<string> {
	return new Set((value ?? "").split(/[\s,]+/).filter((id) => id !== ""));
}
