import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileCredentialStore } from "./agent/auth.ts";
import { loadMcpServers } from "./agent/mcp.ts";
import { createAgentModels, resolveModel } from "./agent/models.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";

type Line = { ok: boolean | "warn"; label: string; detail: string };

/** Discord's permission bits the bot needs: view, send, threads, history, attach files. */
const PERMISSIONS = 1024n + 2048n + 65536n + 32768n + 34359738368n + 274877906944n;
/** Application flags: the Message Content intent, enabled (verified apps) or limited (others). */
const MESSAGE_CONTENT = (1 << 18) | (1 << 19);

export function inviteUrl(applicationId: string): string {
	return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`;
}

/**
 * Check the setup end to end without starting the bot: the config, the bot token and its Message Content intent, who
 * may prompt, the model and its credentials, MCP servers, and the directories. Prints one line per check; false when
 * something must be fixed. The token is never printed.
 */
export async function runChecks(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<boolean> {
	const lines: Line[] = [];
	const print = () => {
		for (const line of lines) {
			const mark = line.ok === true ? "✓" : line.ok === "warn" ? "!" : "✗";
			process.stdout.write(`${mark} ${line.label.padEnd(12)} ${line.detail.replace(/\n/g, "\n                ")}\n`);
		}
	};
	let config: Config;
	try {
		config = loadConfig(env, cwd);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		lines.push({ ok: false, label: "config", detail: error.message });
		print();
		return false;
	}
	lines.push({ ok: true, label: "config", detail: config.configFile ?? "no config.json; environment variables only" });
	lines.push(...(await checkDiscord(config)));
	const who = [
		config.allowedUserIds.size > 0 ? `${config.allowedUserIds.size} user(s)` : "",
		config.allowedRoleIds.size > 0 ? `${config.allowedRoleIds.size} role(s)` : "",
	].filter((each) => each !== "");
	lines.push(
		who.length > 0
			? { ok: true, label: "access", detail: `${who.join(" and ")} may prompt` }
			: { ok: "warn", label: "access", detail: "everyone who can see a channel may prompt and run shell commands here" },
	);
	lines.push(
		config.channelIds.size > 0
			? { ok: true, label: "channels", detail: `tasks start in ${config.channelIds.size} channel(s)` }
			: { ok: true, label: "channels", detail: "tasks start in any channel the bot can see" },
	);
	if (config.guildIds.length === 0) {
		lines.push({ ok: "warn", label: "commands", detail: "slash commands are global and can take up to an hour to appear; add your server to discord.guilds" });
	}
	lines.push(...(await checkModel(config)));
	lines.push(await checkMcp(config));
	for (const [label, dir] of [
		["workspace", config.workdir],
		["data", config.dataDir],
	] as const) {
		lines.push(await checkWritable(label, dir, label === "workspace" ? ` (${config.workspaceMode})` : ""));
	}
	print();
	return !lines.some((line) => line.ok === false);
}

async function checkDiscord(config: Config): Promise<Line[]> {
	const get = async (path: string) => {
		const response = await fetch(`https://discord.com/api/v10${path}`, {
			headers: { Authorization: `Bot ${config.discordToken}` },
			signal: AbortSignal.timeout(10_000),
		});
		return { status: response.status, body: response.ok ? ((await response.json()) as Record<string, unknown>) : undefined };
	};
	try {
		const app = await get("/oauth2/applications/@me");
		if (app.status === 401) return [{ ok: false, label: "token", detail: "Discord rejected the bot token; copy it again from the Bot page" }];
		if (app.body === undefined) return [{ ok: "warn", label: "token", detail: `could not verify (Discord answered ${app.status})` }];
		const bot = (app.body.bot as { username?: string } | undefined)?.username ?? String(app.body.name);
		const flags = Number(app.body.flags ?? 0);
		const id = String(app.body.id);
		return [
			{ ok: true, label: "token", detail: `bot ${bot}` },
			(flags & MESSAGE_CONTENT) !== 0
				? { ok: true, label: "intent", detail: "Message Content intent is on" }
				: {
						ok: false,
						label: "intent",
						detail: `turn on Message Content Intent: https://discord.com/developers/applications/${id}/bot`,
					},
			{ ok: true, label: "invite", detail: inviteUrl(id) },
		];
	} catch (error) {
		return [{ ok: "warn", label: "token", detail: `could not reach Discord to verify it (${(error as Error).message})` }];
	}
}

async function checkModel(config: Config): Promise<Line[]> {
	const name = `${config.provider}/${config.modelId}`;
	try {
		const models = createAgentModels(config.provider, new FileCredentialStore(config.authFile));
		resolveModel(models, { provider: config.provider, modelId: config.modelId }, config.thinkingLevel);
		const auth = await models.checkAuth(config.provider);
		return [
			{ ok: true, label: "model", detail: `${name}, thinking ${config.thinkingLevel}` },
			auth === undefined
				? { ok: false, label: "login", detail: `no credentials for ${config.provider}: run \`pi\` and /login, or set its API key variable` }
				: { ok: true, label: "login", detail: `${config.provider} credentials found` },
		];
	} catch (error) {
		return [{ ok: false, label: "model", detail: (error as Error).message }];
	}
}

async function checkMcp(config: Config): Promise<Line> {
	if (config.mcpConfigPath === undefined) return { ok: true, label: "mcp", detail: "off" };
	try {
		const servers = await loadMcpServers(config.mcpConfigPath, process.env);
		if (servers.length === 0) return { ok: true, label: "mcp", detail: `no servers (${config.mcpConfigPath})` };
		return { ok: true, label: "mcp", detail: `${servers.map((server) => server.name).join(", ")} (connected at startup)` };
	} catch (error) {
		return { ok: false, label: "mcp", detail: (error as Error).message };
	}
}

async function checkWritable(label: string, dir: string, note: string): Promise<Line> {
	try {
		await mkdir(dir, { recursive: true });
		const probe = join(dir, `.write-check-${process.pid}`);
		await writeFile(probe, "");
		await rm(probe);
		return { ok: true, label, detail: `${dir}${note}` };
	} catch (error) {
		return { ok: false, label, detail: `${dir} is not writable: ${(error as Error).message}` };
	}
}

if (import.meta.main) {
	const ok = await runChecks();
	process.stdout.write(ok ? "\nAll set: `npm start`.\n" : "\nFix the ✗ lines above (`npm run setup` edits config.json), then run `npm run check` again.\n");
	process.exit(ok ? 0 : 1);
}
