import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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
	readonly logLevel: LogLevel;
	/** The config file the settings came from, if there was one. */
	readonly configFile?: string;
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const oneOf = <const T extends string[]>(values: readonly [...T], description: string) => Type.Enum(values, { description });
const ids = (description: string) => Type.Array(Type.String({ pattern: "^[0-9]+$" }), { description });
const section = <T extends Parameters<typeof Type.Object>[0]>(properties: T, description: string) =>
	Type.Optional(Type.Object(properties, { additionalProperties: false, description }));

/**
 * `config.json`: every setting in one file. Each one can also come from an environment variable (or `.env`), which
 * wins over the file. Relative paths are relative to the file; `~` is the home directory.
 */
export const ConfigFileSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		discord: section(
			{
				token: Type.Optional(
					Type.String({ description: "Bot token. Better kept in .env as DISCORD_TOKEN, which wins over this." }),
				),
				allowedUsers: Type.Optional(
					ids("User ids allowed to prompt (Developer Mode → right-click a user → Copy User ID). Env: DISCORD_ALLOWED_USERS"),
				),
				allowedRoles: Type.Optional(ids("Role ids allowed to prompt. Env: DISCORD_ALLOWED_ROLES")),
				allowEveryone: Type.Optional(
					Type.Boolean({
						description:
							"Let everyone who can see a channel prompt (and run shell commands on this machine). Needed when no users or roles are set. Env: DISCORD_ALLOW_EVERYONE=1",
					}),
				),
				channels: Type.Optional(ids("Channels where mentions and /pi start tasks; empty means all. Env: DISCORD_CHANNELS")),
				guilds: Type.Optional(
					ids("Servers to register slash commands in right away; otherwise they are global and can take an hour. Env: DISCORD_GUILDS"),
				),
				maxAttachmentMB: Type.Optional(
					Type.Number({ minimum: 0, description: "Larger attachments are named to the model but not saved. Default 25. Env: DISCORD_MAX_ATTACHMENT_MB" }),
				),
			},
			"Discord: who may use the bot, and where",
		),
		model: section(
			{
				provider: Type.Optional(Type.String({ description: "A built-in pi-ai provider, like anthropic, openai or deepseek. Default: pi's defaultProvider. Env: PI_PROVIDER" })),
				id: Type.Optional(Type.String({ description: "Model id of that provider. Default: pi's defaultModel. Env: PI_MODEL" })),
				thinking: Type.Optional(oneOf(THINKING_LEVELS, "Thinking level. Default: pi's defaultThinkingLevel, else medium. Env: PI_THINKING")),
			},
			"The model every task uses; credentials come from pi's auth.json or the provider's API key variable",
		),
		workspace: section(
			{
				dir: Type.Optional(Type.String({ description: "Root of the agent's files. Default ./workspace. Env: PI_WORKDIR" })),
				mode: Type.Optional(
					oneOf(
						["per-thread", "shared"] as const,
						"per-thread: each task works in <dir>/<threadId>. shared: every task works in <dir>, like one repo checkout. Env: PI_WORKSPACE_MODE",
					),
				),
				instructions: Type.Optional(
					Type.String({ description: "Project instructions for every task. Default <dir>/AGENTS.md. Env: PI_INSTRUCTIONS" }),
				),
			},
			"Where the agent works",
		),
		dataDir: Type.Optional(Type.String({ description: "SQLite database and files waiting to be posted. Default ./data. Env: PI_DATA_DIR" })),
		pi: section(
			{
				agentDir: Type.Optional(
					Type.String({ description: "pi's agent directory (settings, auth, AGENTS.md, mcp.json). Default ~/.pi/agent. Env: PI_CODING_AGENT_DIR" }),
				),
				authFile: Type.Optional(Type.String({ description: "pi's credentials. Default <agentDir>/auth.json. Env: PI_AUTH_FILE" })),
			},
			"pi's files the bot shares",
		),
		mcp: section(
			{
				enabled: Type.Optional(Type.Boolean({ description: "Connect MCP servers. Default true." })),
				config: Type.Optional(
					Type.String({ description: "An mcpServers file. Default <agentDir>/mcp.json. Env: PI_MCP_CONFIG (none turns MCP off)" }),
				),
			},
			"MCP servers",
		),
		codemode: Type.Optional(Type.Boolean({ description: "Offer the codemode tool. Default true. Env: PI_CODEMODE" })),
		logLevel: Type.Optional(oneOf(LOG_LEVELS, "Default info. Env: LOG_LEVEL")),
	},
	{ additionalProperties: false },
);

export type ConfigFile = Static<typeof ConfigFileSchema>;

export const DEFAULT_CONFIG_FILE = "config.json";

/**
 * The bot's settings. For each one, in order: the environment variable, `config.json` (or the file `PI_DISCORD_CONFIG`
 * names), pi's own `settings.json` for the model, then the default.
 */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
	const home = env.HOME?.trim() || homedir();
	const named = text(env.PI_DISCORD_CONFIG);
	const configFile = resolve(cwd, named ?? DEFAULT_CONFIG_FILE);
	const file = readConfigFile(configFile, named !== undefined);
	const base = file === undefined ? cwd : dirname(configFile);
	/** A path from the file is relative to the file, one from the environment to the working directory. */
	const path = (fromEnv: string | undefined, fromFile: string | undefined, fallback: () => string) => {
		if (fromEnv !== undefined) return expand(fromEnv, home, cwd);
		if (fromFile !== undefined) return expand(fromFile, home, base);
		return fallback();
	};
	const f = file ?? {};

	const piAgentDir = path(text(env.PI_CODING_AGENT_DIR), f.pi?.agentDir, () => join(home, ".pi", "agent"));
	const pi = piDefaults(piAgentDir);
	const discordToken = text(env.DISCORD_TOKEN) ?? text(f.discord?.token);
	if (discordToken === undefined) throw new ConfigError("no bot token: set DISCORD_TOKEN in .env (run `npm run setup`)");
	const provider = text(env.PI_PROVIDER) ?? text(f.model?.provider) ?? pi.provider;
	if (provider === undefined) {
		throw new ConfigError('no model provider: set "model.provider" in config.json (pi\'s settings.json has no defaultProvider)');
	}
	// pi's model only means something for pi's provider.
	const modelId = text(env.PI_MODEL) ?? text(f.model?.id) ?? (provider === pi.provider ? pi.model : undefined);
	if (modelId === undefined) throw new ConfigError(`no model: set "model.id" in config.json (a ${provider} model id)`);
	const thinking = text(env.PI_THINKING) ?? f.model?.thinking ?? pi.thinking ?? "medium";
	if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
		throw new ConfigError(`thinking level ${JSON.stringify(thinking)}: use one of ${THINKING_LEVELS.join(", ")}`);
	}
	const workdir = path(text(env.PI_WORKDIR), f.workspace?.dir, () => resolve(cwd, "workspace"));
	const mode = text(env.PI_WORKSPACE_MODE) ?? f.workspace?.mode ?? "per-thread";
	if (mode !== "per-thread" && mode !== "shared") {
		throw new ConfigError(`workspace mode: expected per-thread or shared, got ${JSON.stringify(mode)}`);
	}
	const mcpEnv = text(env.PI_MCP_CONFIG);
	const mcpOff = mcpEnv === "none" || (mcpEnv === undefined && f.mcp?.enabled === false);
	const codemodeEnv = text(env.PI_CODEMODE)?.toLowerCase();
	const logLevel = text(env.LOG_LEVEL) ?? f.logLevel ?? "info";
	if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
		throw new ConfigError(`log level ${JSON.stringify(logLevel)}: use one of ${LOG_LEVELS.join(", ")}`);
	}
	const attachmentMB = Number(text(env.DISCORD_MAX_ATTACHMENT_MB) ?? f.discord?.maxAttachmentMB ?? 25);
	if (!Number.isFinite(attachmentMB) || attachmentMB < 0) throw new ConfigError("DISCORD_MAX_ATTACHMENT_MB: expected a number of megabytes");

	const allowedUserIds = idSet(env.DISCORD_ALLOWED_USERS, f.discord?.allowedUsers);
	const allowedRoleIds = idSet(env.DISCORD_ALLOWED_ROLES, f.discord?.allowedRoles);
	const allowEveryone = text(env.DISCORD_ALLOW_EVERYONE) !== undefined ? env.DISCORD_ALLOW_EVERYONE?.trim() === "1" : f.discord?.allowEveryone === true;
	if (allowedUserIds.size === 0 && allowedRoleIds.size === 0 && !allowEveryone) {
		// Every allowed person can run shell commands on this machine through the agent.
		throw new ConfigError('nobody may use the bot: set "discord.allowedUsers" (or allowedRoles, or allowEveryone) in config.json');
	}
	return {
		discordToken,
		allowedUserIds,
		allowedRoleIds,
		channelIds: idSet(env.DISCORD_CHANNELS, f.discord?.channels),
		guildIds: [...idSet(env.DISCORD_GUILDS, f.discord?.guilds)],
		provider,
		modelId,
		thinkingLevel: thinking as ModelThinkingLevel,
		workdir,
		workspaceMode: mode,
		dataDir: path(text(env.PI_DATA_DIR), f.dataDir, () => resolve(cwd, "data")),
		piAgentDir,
		authFile: path(text(env.PI_AUTH_FILE), f.pi?.authFile, () => join(piAgentDir, "auth.json")),
		instructionsPath: path(text(env.PI_INSTRUCTIONS), f.workspace?.instructions, () => join(workdir, "AGENTS.md")),
		maxAttachmentBytes: attachmentMB * 1024 * 1024,
		mcpConfigPath: mcpOff
			? undefined
			: path(mcpEnv, f.mcp?.config, () => join(piAgentDir, "mcp.json")),
		codemode: codemodeEnv !== undefined ? !["0", "off", "false"].includes(codemodeEnv) : f.codemode !== false,
		logLevel: logLevel as LogLevel,
		...(file === undefined ? {} : { configFile }),
	};
}

/** The parsed config file; undefined when it does not exist and was not named explicitly. */
export function readConfigFile(path: string, required = false): ConfigFile | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
		throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// The file may hold the token: name the problem, never echo the contents.
		throw new ConfigError(`${path} is not valid JSON (${(error as Error).message.replace(/\s*in JSON.*$/s, "")})`);
	}
	const problems = configProblems(parsed);
	if (problems.length > 0) throw new ConfigError(`${path}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	return parsed as ConfigFile;
}

/** Readable problems of a config file, one per setting: unknown settings, wrong types, values not allowed. */
export function configProblems(value: unknown): string[] {
	const byPath = new Map<string, string>();
	for (const error of Value.Errors(ConfigFileSchema, value)) {
		const at = settingName(error.instancePath);
		if (error.keyword === "additionalProperties") {
			const extra = (error.params as { additionalProperties?: string[] }).additionalProperties ?? [];
			for (const name of extra) byPath.set(`${at}.${name}`, `unknown setting "${at === "" ? name : `${at}.${name}`}"`);
		} else if (error.keyword === "enum") {
			const values = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
			byPath.set(at, `${at}: use one of ${values.map((each) => JSON.stringify(each)).join(", ")}`);
		} else if (error.keyword === "pattern") {
			byPath.set(at, `${at}: Discord ids are numbers written as strings, like "123456789012345678"`);
		} else if (error.keyword !== "boolean" && !byPath.has(at)) {
			// "boolean" is the `false` schema an unknown setting also fails; additionalProperties already named it.
			byPath.set(at, `${at === "" ? "the file" : at} ${error.message}`);
		}
	}
	return [...byPath.values()];
}

/** `/discord/allowedUsers/0` → `discord.allowedUsers[0]`. */
function settingName(pointer: string): string {
	return pointer
		.split("/")
		.slice(1)
		.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
		.join("")
		.replace(/^\./, "");
}

function expand(path: string, home: string, base: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return resolve(base, path);
}

/** pi's model defaults from its settings.json. */
export function piDefaults(agentDir: string): { provider?: string; model?: string; thinking?: string } {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
	const pick = (key: string) => (typeof settings[key] === "string" ? text(settings[key] as string) : undefined);
	return { provider: pick("defaultProvider"), model: pick("defaultModel"), thinking: pick("defaultThinkingLevel") };
}

function text(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Ids from the environment (comma or space separated) when set there, else from the file. */
function idSet(fromEnv: string | undefined, fromFile: readonly string[] | undefined): ReadonlySet<string> {
	if (text(fromEnv) !== undefined) return new Set((fromEnv ?? "").split(/[\s,]+/).filter((id) => id !== ""));
	return new Set(fromFile ?? []);
}
