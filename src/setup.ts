import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { createModels, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { runChecks } from "./check.ts";
import { type ConfigFile, ConfigError, DEFAULT_CONFIG_FILE, piDefaults, readConfigFile } from "./config.ts";

/**
 * `npm run setup`: asks for the few things the bot needs and writes `config.json`, with the bot token in `.env`.
 * Running it again edits the existing settings; Enter keeps the value in brackets.
 */
async function setup(): Promise<void> {
	if (!process.stdin.isTTY) throw new Error("setup asks questions: run it in a terminal");
	const cwd = process.cwd();
	const configPath = resolve(cwd, process.env.PI_DISCORD_CONFIG?.trim() || DEFAULT_CONFIG_FILE);
	const envPath = resolve(cwd, ".env");
	let current: ConfigFile = {};
	try {
		current = readConfigFile(configPath) ?? {};
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		say(`The existing ${configPath} has problems, so setup starts fresh:\n${error.message}\n`);
	}
	const pi = piDefaults(current.pi?.agentDir?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), ".pi", "agent"));

	let muted = false;
	const output = new Writable({
		write(chunk, encoding, done) {
			if (!muted) process.stdout.write(chunk, encoding);
			done();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	const ask = async (question: string, fallback?: string): Promise<string> => {
		const hint = fallback === undefined || fallback === "" ? "" : ` [${fallback}]`;
		const answer = (await rl.question(`${question}${hint}: `)).trim();
		return answer === "" ? (fallback ?? "") : answer;
	};
	const askIds = async (question: string, fallback: readonly string[] | undefined): Promise<string[]> => {
		for (;;) {
			const answer = await ask(`${question} (comma-separated, - for none)`, fallback?.join(",") ?? "");
			if (answer === "-") return [];
			const list = answer.split(/[\s,]+/).filter((id) => id !== "");
			if (list.every((id) => /^\d{15,25}$/.test(id))) return list;
			say("  Discord ids are long numbers. Turn on Developer Mode (Settings → Advanced), then right-click → Copy ID.");
		}
	};

	try {
		say("pi-durable-discord setup. Enter keeps the value in [brackets].\n");

		say("1. Discord bot. Create an application at https://discord.com/developers/applications, add a bot,");
		say("   turn on Message Content Intent on the Bot page, and copy its token (Reset Token).");
		const savedToken = readEnvToken(envPath);
		process.stdout.write(`Bot token${savedToken === undefined ? "" : " [keep the one in .env]"} (hidden): `);
		muted = true;
		const token = (await rl.question("")).trim();
		muted = false;
		process.stdout.write("\n");
		if (token === "" && savedToken === undefined) say("  No token yet: add DISCORD_TOKEN to .env before starting the bot.");

		say("\n2. Who may use the bot. Everyone allowed can run shell commands on this machine.");
		const allowedUsers = await askIds("Your Discord user id(s)", current.discord?.allowedUsers);
		const allowedRoles = await askIds("Role ids that may also use it", current.discord?.allowedRoles);
		const allowEveryone =
			allowedUsers.length === 0 && allowedRoles.length === 0
				? (await ask("No users or roles: let everyone in the server use it? (yes/no)", "no")).toLowerCase().startsWith("y")
				: false;

		say("\n3. Where. A server id registers slash commands right away (right-click the server → Copy Server ID).");
		const guilds = await askIds("Server id(s)", current.discord?.guilds);
		const channels = await askIds("Only start tasks in these channel ids", current.discord?.channels ?? []);

		say("\n4. Model. Credentials come from pi (`pi`, then /login) or the provider's API key variable.");
		const providers = builtinProviders();
		const piProvider = providers.some((each) => each.id === pi.provider) ? pi.provider : undefined;
		if (pi.provider !== undefined && piProvider === undefined) {
			say(`  pi's default provider ${pi.provider} is not built in (models.json providers are not supported yet).`);
		}
		let provider: string;
		for (;;) {
			provider = await ask("Provider", current.model?.provider ?? piProvider ?? "anthropic");
			if (providers.some((each) => each.id === provider)) break;
			say(`  Unknown provider. Built-in: ${providers.map((each) => each.id).join(", ")}`);
		}
		const models = createModels();
		models.setProvider(providers.find((each) => each.id === provider) as (typeof providers)[number]);
		const known = models.getModels(provider);
		const defaultModel =
			current.model?.provider === provider ? current.model.id : provider === pi.provider ? pi.model : known[0]?.id;
		let modelId: string;
		for (;;) {
			modelId = await ask("Model id", defaultModel);
			if (models.getModel(provider, modelId) !== undefined) break;
			say(`  Unknown model. Some ${provider} models: ${known.slice(0, 15).map((each) => each.id).join(", ")}`);
		}
		const model = models.getModel(provider, modelId);
		const levels = model?.reasoning === true ? getSupportedThinkingLevels(model) : (["off"] as ModelThinkingLevel[]);
		const preferred = [current.model?.thinking, pi.thinking, "medium"].find(
			(each): each is ModelThinkingLevel => each !== undefined && levels.includes(each as ModelThinkingLevel),
		);
		let thinking: string;
		for (;;) {
			thinking = await ask(`Thinking level (${levels.join(", ")})`, preferred ?? levels[0]);
			if (levels.includes(thinking as ModelThinkingLevel)) break;
		}

		say("\n5. Workspace. per-thread: every task gets its own folder. shared: all tasks work in one folder (a repo checkout).");
		let mode: string;
		for (;;) {
			mode = await ask("Mode (per-thread, shared)", current.workspace?.mode ?? "per-thread");
			if (mode === "per-thread" || mode === "shared") break;
		}
		const dir = await ask("Folder", current.workspace?.dir ?? "./workspace");

		const next: ConfigFile = {
			...current,
			$schema: "./config.schema.json",
			discord: {
				...current.discord,
				allowedUsers,
				allowedRoles,
				...(allowEveryone ? { allowEveryone } : {}),
				guilds,
				channels,
			},
			model: { provider, id: modelId, thinking: thinking as ModelThinkingLevel },
			workspace: { ...current.workspace, dir, mode: mode as "per-thread" | "shared" },
		};
		if (!allowEveryone && next.discord !== undefined) delete next.discord.allowEveryone;
		// The token lives in .env only.
		if (next.discord !== undefined) delete next.discord.token;
		writeFileSync(configPath, `${JSON.stringify(next, null, "\t")}\n`);
		say(`\nWrote ${configPath}`);
		if (token !== "") {
			writeEnvToken(envPath, token);
			say(`Wrote the token to ${envPath} (readable only by you)`);
		}

		say("\nChecking the setup…\n");
		rl.close();
		if (token !== "") process.env.DISCORD_TOKEN = token;
		else if (savedToken !== undefined) process.env.DISCORD_TOKEN = savedToken;
		const ok = await runChecks(process.env, cwd);
		say(ok ? "\nAll set: invite the bot with the link above, then `npm start`." : "\nFix the ✗ lines, then `npm run check`.");
	} finally {
		rl.close();
	}
}

function say(text: string): void {
	process.stdout.write(`${text}\n`);
}

function readEnvToken(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const line = readFileSync(path, "utf8")
		.split("\n")
		.find((each) => /^\s*DISCORD_TOKEN\s*=/.test(each));
	const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
	return value === undefined || value === "" ? undefined : value;
}

/** Set DISCORD_TOKEN in .env, keeping its other lines, and make the file private. */
function writeEnvToken(path: string, token: string): void {
	const lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
	const at = lines.findIndex((line) => /^\s*#?\s*DISCORD_TOKEN\s*=/.test(line));
	if (at >= 0) lines[at] = `DISCORD_TOKEN=${token}`;
	else lines.unshift(`DISCORD_TOKEN=${token}`);
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

if (import.meta.main) {
	setup().catch((error: unknown) => {
		process.stderr.write(`setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
