import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { Config } from "../config.ts";
import { createDeliverTask, type DeliverTask } from "../discord/deliver.ts";
import type { DiscordPort } from "../discord/port.ts";
import { TaskDirectory } from "../discord/tasks.ts";
import { errorSummary, type Logger } from "../log.ts";
import { FileCredentialStore } from "./auth.ts";
import { buildSafeEnv, createDiscordExtension, createPromptExtension, createWorkspaceTools } from "./extensions.ts";
import { connectMcpServers, loadMcpServers, type McpServerSpec } from "./mcp.ts";
import { createAgentModels, resolveModel, StartupError } from "./models.ts";

export type Agent = {
	readonly harness: Harness;
	readonly directory: TaskDirectory;
	readonly deliver: DeliverTask;
	readonly models: MutableModels;
	/** Delivery reaches Discord through this port; set it before `harness.resume()`. */
	setPort(port: DiscordPort): void;
	/** Close the Harness (running work continues on the next start), then the code mode sandbox and MCP servers. */
	close(context: Context): Promise<void>;
};

export type OpenAgentDeps = {
	readonly log: Logger;
	/** Models to use instead of the configured provider (tests use pi-ai's faux provider). */
	readonly models?: MutableModels;
	/** Environment the agent's bash sees, before the allowlist filter; default `process.env`. */
	readonly shellEnv?: Readonly<Record<string, string | undefined>>;
	readonly previewIntervalMs?: number;
	/** Tests connect MCP servers in memory. */
	readonly mcpTransport?: (spec: McpServerSpec) => McpTransport;
};

export const DATABASE_FILE = "durable.sqlite";

/**
 * Open the agent: models and auth check, the registry (pi's coding tools, prompt, Discord delivery) and the Harness
 * over SQLite in the data directory. Nothing runs until the caller sets the port and calls `harness.resume()`.
 */
export async function openAgent(config: Config, deps: OpenAgentDeps): Promise<Agent> {
	const { log } = deps;
	await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
	await mkdir(config.workdir, { recursive: true });
	const models = deps.models ?? createAgentModels(config.provider, new FileCredentialStore(config.authFile));
	const ref = { provider: config.provider, modelId: config.modelId };
	resolveModel(models, ref, config.thinkingLevel);
	if ((await models.checkAuth(config.provider)) === undefined) {
		throw new StartupError(`not logged in to ${config.provider}: run \`pi\` and /login, or set its API key`, 4);
	}
	let port: DiscordPort | undefined;
	const deliver = createDeliverTask({
		port: () => {
			if (port === undefined) throw new Error("Discord port used before it was set");
			return port;
		},
		log,
		model: ref,
		...(deps.previewIntervalMs === undefined ? {} : { previewIntervalMs: deps.previewIntervalMs }),
	});
	const safeEnv = buildSafeEnv(deps.shellEnv ?? process.env);
	// MCP servers get the same allowlisted environment as bash, plus the env their config gives them.
	const specs = config.mcpConfigPath === undefined ? [] : await loadMcpServers(config.mcpConfigPath, process.env);
	const mcp = await connectMcpServers(specs, {
		log,
		baseEnv: safeEnv,
		...(deps.mcpTransport === undefined ? {} : { transport: deps.mcpTransport }),
	});
	if (specs.length > 0) log.info("mcp_ready", { servers: mcp.summary });
	const sandbox = config.codemode ? new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }) : undefined;
	const registry = createRegistry();
	registry.install(createWorkspaceTools(safeEnv));
	registry.install(mcp.extension);
	registry.install(createToolSearchExtension());
	if (sandbox !== undefined) registry.install(createCodemodeExtension({ sandbox, namespaces: mcp.namespaces }));
	registry.install(
		createPromptExtension({
			globalInstructions: join(config.piAgentDir, "AGENTS.md"),
			projectInstructions: config.instructionsPath,
		}),
	);
	registry.install(
		createDiscordExtension({
			deliver,
			port: () => {
				if (port === undefined) throw new Error("Discord port used before it was set");
				return port;
			},
			outboxDir: join(config.dataDir, "outbox"),
		}),
	);
	const storage = await openNodeSqliteStorage(join(config.dataDir, DATABASE_FILE));
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			identity: { attribution: { name: "pi-durable-discord", url: "https://github.com/earendil-works/pi" } },
			settings: {
				// Discord shows an edit about once a second at best; fewer commits keep SQLite quiet with many tasks.
				progress: { partialIntervalMs: 500, outputIntervalMs: 1000 },
				afterFailedRun: "continue",
			},
			env: async (target) => {
				const cwd = target.cwd ?? config.workdir;
				await mkdir(cwd, { recursive: true });
				return new NodeExecutionEnv({ cwd });
			},
			onReport: (error, info) => log.warn("harness_report", { type: info?.type, error: errorSummary(error) }),
		},
		BG,
	);
	const directory = new TaskDirectory(harness, deliver, {
		model: ref,
		thinkingLevel: config.thinkingLevel,
		workdir: config.workdir,
		workspaceMode: config.workspaceMode,
	});
	return {
		harness,
		directory,
		deliver,
		models,
		setPort: (next) => {
			port = next;
		},
		close: async (context) => {
			await harness.close(context);
			await sandbox?.close();
			await mcp.close();
		},
	};
}
