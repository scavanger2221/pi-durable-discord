import { readFile } from "node:fs/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import {
	McpClient,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
	type Tool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { ConfigError } from "../config.ts";
import { errorSummary, type Logger } from "../log.ts";

/** One server of an `mcpServers` config (the format pi's MCP extension, Claude and Cursor use). */
export type McpServerSpec =
	| { name: string; kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
	| { name: string; kind: "http"; url: string; headers: Record<string, string> };

const CONNECT_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_DESCRIPTION = 1024;

/**
 * Servers of an `mcpServers` JSON file; none when the file does not exist. `${VAR}` in env, headers and args is
 * replaced from `env`. Entries with `disabled: true` (or `enabled: false`) are skipped.
 */
export async function loadMcpServers(path: string, env: Readonly<Record<string, string | undefined>>): Promise<McpServerSpec[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The file may hold secrets: name it, never echo it.
		throw new ConfigError(`${path} is not valid JSON`);
	}
	const servers = record(record(parsed)?.mcpServers ?? record(parsed)?.servers);
	if (servers === undefined) throw new ConfigError(`${path} has no "mcpServers" object`);
	const expand = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? "");
	const strings = (value: unknown) =>
		Object.fromEntries(Object.entries(record(value) ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, expand(v)]] : [])));
	const specs: McpServerSpec[] = [];
	for (const [name, value] of Object.entries(servers)) {
		const entry = record(value);
		if (entry === undefined || entry.disabled === true || entry.enabled === false) continue;
		if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ConfigError(`MCP server name ${JSON.stringify(name)}: use letters, digits, _ and -`);
		if (typeof entry.command === "string") {
			const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string").map(expand) : [];
			specs.push({
				name,
				kind: "stdio",
				command: entry.command,
				args,
				env: strings(entry.env),
				...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
			});
		} else if (typeof entry.url === "string") {
			specs.push({ name, kind: "http", url: expand(entry.url), headers: strings(entry.headers) });
		} else throw new ConfigError(`MCP server ${name}: needs "command" or "url"`);
	}
	return specs;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export type McpConnectDeps = {
	readonly log: Logger;
	/** Environment of stdio servers before their own `env`: the agent's allowlisted one, so no bot secrets leak. */
	readonly baseEnv: Readonly<Record<string, string>>;
	/** Tests pass an in-memory transport. */
	readonly transport?: (spec: McpServerSpec) => McpTransport;
};

export type McpServers = {
	/** The servers' tools (deferred: loaded with `tool_search` or called from codemode) and a prompt section. */
	readonly extension: Extension;
	/** One codemode namespace per server, so scripts can browse a server's tools. */
	readonly namespaces: readonly CodemodeNamespace[];
	/** Connected servers and their tool counts, for the startup log. */
	readonly summary: Record<string, number>;
	close(): Promise<void>;
};

/**
 * Connect every server at once and wrap its tools. A server that fails to start is logged and left out, so one
 * broken server does not keep the bot down. A connection that drops is opened again on the next call.
 */
export async function connectMcpServers(specs: readonly McpServerSpec[], deps: McpConnectDeps): Promise<McpServers> {
	const connected = await Promise.all(
		specs.map(async (spec) => {
			const server = new McpServer(spec, deps);
			try {
				const tools = await server.start();
				return { server, tools };
			} catch (error) {
				deps.log.warn("mcp_server_failed", { server: spec.name, error: errorSummary(error) });
				await server.close();
				return undefined;
			}
		}),
	);
	const live = connected.filter((each) => each !== undefined);
	const tools = live.flatMap(({ server, tools }) => tools.map((tool) => mcpTool(server, tool)));
	const lines = live.map(
		({ server, tools }) => `- ${server.name} (${tools.length} tools)${server.instructions === undefined ? "" : `: ${firstLine(server.instructions)}`}`,
	);
	const prompt = [
		"MCP servers are connected. Their tools are named mcp__<server>__<tool> and are not offered until you load them: find them with tool_search, or call them from a codemode script as tools.mcp__<server>__<tool>(args).",
		...lines,
	].join("\n");
	return {
		extension: defineExtension({
			name: "mcp",
			tools: tools as unknown as ToolRegistration[],
			sections: [section("mcp_servers", () => (live.length === 0 ? undefined : prompt))],
		}),
		namespaces: live.map(({ server }) => ({
			name: server.name,
			description: server.instructions === undefined ? `MCP server ${server.name}` : firstLine(server.instructions),
			prefix: prefixOf(server.name),
		})),
		summary: Object.fromEntries(live.map(({ server, tools }) => [server.name, tools.length])),
		close: async () => {
			await Promise.all(live.map(({ server }) => server.close()));
		},
	};
}

/** One server's client, reopened when its connection drops (a crashed stdio server, a closed HTTP session). */
class McpServer {
	readonly spec: McpServerSpec;
	readonly #deps: McpConnectDeps;
	#client: Promise<McpClient> | undefined;
	#current: McpClient | undefined;
	#closed = false;
	instructions: string | undefined;

	constructor(spec: McpServerSpec, deps: McpConnectDeps) {
		this.spec = spec;
		this.#deps = deps;
	}

	get name(): string {
		return this.spec.name;
	}

	async start(): Promise<Tool[]> {
		const client = await this.client();
		return client.listTools();
	}

	client(): Promise<McpClient> {
		if (this.#closed) return Promise.reject(new Error(`MCP server ${this.name} is closed`));
		this.#client ??= this.#connect().catch((error: unknown) => {
			this.#client = undefined;
			throw error;
		});
		return this.#client;
	}

	async #connect(): Promise<McpClient> {
		// The timeout also bounds `initialize`, which waits for a stdio server to start (`npx -y` may download it first).
		const client = new McpClient({ name: "pi-durable-discord", version: "0.1.0", requestTimeoutMs: CONNECT_TIMEOUT_MS });
		client.onClose(() => {
			if (this.#current !== client) return;
			this.#current = undefined;
			this.#client = undefined;
		});
		const result = await client.connect(this.#transport());
		this.#current = client;
		this.instructions = result.instructions?.trim() || undefined;
		this.#deps.log.info("mcp_connected", { server: this.name, as: result.serverInfo.name });
		return client;
	}

	#transport(): McpTransport {
		if (this.#deps.transport !== undefined) return this.#deps.transport(this.spec);
		const spec = this.spec;
		if (spec.kind === "http") return new StreamableHttpTransport({ url: spec.url, headers: spec.headers });
		return new StdioTransport({
			command: spec.command,
			args: spec.args,
			env: { ...this.#deps.baseEnv, ...spec.env },
			inheritEnv: false,
			...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
			stderr: "pipe",
			onStderr: (chunk) => this.#deps.log.debug("mcp_stderr", { server: this.name, text: chunk.slice(0, 500) }),
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		const client = this.#client;
		this.#client = undefined;
		this.#current = undefined;
		await client?.then((each) => each.close()).catch(() => undefined);
	}
}

function prefixOf(server: string): string {
	return `mcp__${server}__`;
}

/** Provider tool names allow at most 64 characters of `[A-Za-z0-9_-]`. */
export function mcpToolName(server: string, tool: string): string {
	return `${prefixOf(server)}${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function mcpTool(server: McpServer, tool: Tool) {
	const description = tool.description ?? tool.title ?? `MCP tool ${tool.name}`;
	return defineTool({
		name: mcpToolName(server.name, tool.name),
		description: `[${server.name}] ${description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description}`,
		// Providers require an object schema, and some reject one without `properties`.
		parameters: Type.Unsafe<Record<string, unknown>>({
			...tool.inputSchema,
			type: "object",
			properties: (tool.inputSchema.properties as object | undefined) ?? {},
		}),
		// Large tool sets stay out of every request until the model asks for them.
		deferred: true,
		execute: async (args, _api, context) => {
			const client = await server.client();
			const result = await client.callTool(tool.name, args, {
				timeoutMs: CALL_TIMEOUT_MS,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});
			const output: (TextContent | ImageContent)[] = toLlmContent(result);
			// MCP reports tool failures in the result instead of as a protocol error.
			const isError = result.isError === true;
			if (output.length === 0) output.push({ type: "text", text: isError ? `MCP tool ${tool.name} failed` : "(no output)" });
			return { output, isError };
		},
	});
}

function firstLine(text: string): string {
	const line = text.split("\n").find((each) => each.trim() !== "")?.trim() ?? "";
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
