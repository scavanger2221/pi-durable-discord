import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError, configProblems, loadConfig } from "../src/config.ts";
import { configJsonSchema } from "../src/schema.ts";

describe("config", () => {
	let dir: string;
	let home: string;
	const write = (name: string, value: unknown) =>
		writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-discord-config-"));
		home = join(dir, "home");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high" }),
		);
	});
	after(() => rm(dir, { recursive: true, force: true }));

	it("reads config.json, falling back to pi's settings for the model", async () => {
		await write("config.json", {
			discord: { allowedUsers: ["111111111111111111"], guilds: ["222222222222222222"] },
			workspace: { dir: "work", mode: "shared" },
			pi: { agentDir: "~/.pi/agent" },
			mcp: { enabled: false },
		});
		const config = loadConfig({ HOME: home, DISCORD_TOKEN: "t" }, dir);
		assert.equal(config.configFile, join(dir, "config.json"));
		assert.deepEqual([...config.allowedUserIds], ["111111111111111111"]);
		assert.deepEqual(config.guildIds, ["222222222222222222"]);
		assert.equal(config.provider, "deepseek");
		assert.equal(config.modelId, "deepseek-chat");
		assert.equal(config.thinkingLevel, "high");
		assert.equal(config.workdir, join(dir, "work"));
		assert.equal(config.workspaceMode, "shared");
		assert.equal(config.instructionsPath, join(dir, "work", "AGENTS.md"));
		assert.equal(config.authFile, join(home, ".pi", "agent", "auth.json"));
		assert.equal(config.mcpConfigPath, undefined);
		assert.equal(config.codemode, true);
	});

	it("lets environment variables win over the file", async () => {
		await write("config.json", {
			discord: { allowedUsers: ["111111111111111111"] },
			model: { provider: "anthropic", id: "claude-sonnet-5-5" },
			codemode: true,
		});
		const config = loadConfig(
			{ HOME: home, DISCORD_TOKEN: "t", DISCORD_ALLOWED_USERS: "333, 444", PI_MODEL: "claude-opus-5-5", PI_CODEMODE: "off" },
			dir,
		);
		assert.deepEqual([...config.allowedUserIds], ["333", "444"]);
		assert.equal(config.provider, "anthropic");
		assert.equal(config.modelId, "claude-opus-5-5");
		assert.equal(config.codemode, false);
	});

	it("needs a token and someone allowed to prompt", async () => {
		await write("config.json", { model: { provider: "anthropic", id: "claude-sonnet-5-5" } });
		assert.throws(() => loadConfig({ HOME: home }, dir), /no bot token/);
		assert.throws(() => loadConfig({ HOME: home, DISCORD_TOKEN: "t" }, dir), /nobody may use the bot/);
		await write("config.json", { discord: { allowEveryone: true }, model: { provider: "anthropic", id: "claude-sonnet-5-5" } });
		assert.equal(loadConfig({ HOME: home, DISCORD_TOKEN: "t" }, dir).allowedUserIds.size, 0);
	});

	it("reports a broken file without echoing it", async () => {
		await write("config.json", '{ "discord": { "token": "secret-token", }');
		assert.throws(
			() => loadConfig({ HOME: home }, dir),
			(error: Error) => error instanceof ConfigError && /not valid JSON/.test(error.message) && !error.message.includes("secret-token"),
		);
		assert.throws(() => loadConfig({ HOME: home, PI_DISCORD_CONFIG: "missing.json" }, dir), /cannot read/);
	});

	it("explains invalid settings one per line", () => {
		const problems = configProblems({
			discord: { allowedUsers: [123], channels: ["#general"] },
			model: { thinking: "huge" },
			workspace: { mode: "everywhere" },
			colour: "blue",
		});
		assert.equal(problems.filter((each) => each.includes("colour")).length, 1, problems.join("\n"));
		assert.ok(problems.includes('unknown setting "colour"'), problems.join("\n"));
		assert.ok(problems.some((each) => each.startsWith("discord.allowedUsers[0]")), problems.join("\n"));
		assert.ok(problems.some((each) => each.startsWith("discord.channels[0]: Discord ids")), problems.join("\n"));
		assert.ok(problems.some((each) => each.startsWith('model.thinking: use one of "off"')), problems.join("\n"));
		assert.ok(problems.includes('workspace.mode: use one of "per-thread", "shared"'), problems.join("\n"));
		assert.deepEqual(configProblems({}), []);
	});

	it("ships an example that validates and a schema that is up to date", async () => {
		const root = new URL("../", import.meta.url);
		assert.deepEqual(configProblems(JSON.parse(await readFile(new URL("config.example.json", root), "utf8"))), []);
		assert.equal(
			await readFile(new URL("config.schema.json", root), "utf8"),
			configJsonSchema(),
			"run `npm run schema`",
		);
	});
});
