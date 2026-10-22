import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadMcpServers, mcpToolName } from "../src/agent/mcp.ts";

describe("loadMcpServers", () => {
	it("reads stdio and http servers, expands ${VAR} and skips disabled ones", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				mcpServers: {
					exa: { command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "${EXA}" } },
					remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
					off: { command: "x", disabled: true },
				},
			}),
		);
		const servers = await loadMcpServers(path, { EXA: "k1", TOKEN: "t1" });
		assert.deepEqual(servers, [
			{ name: "exa", kind: "stdio", command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "k1" } },
			{ name: "remote", kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t1" } },
		]);
		assert.deepEqual(await loadMcpServers(join(dir, "missing.json"), {}), []);
		await writeFile(path, "{ not json, secret");
		await assert.rejects(loadMcpServers(path, {}), (error: Error) => !error.message.includes("secret"));
		await rm(dir, { recursive: true, force: true });
	});

	it("makes provider-safe tool names", () => {
		assert.equal(mcpToolName("chrome-devtools", "take.screenshot"), "mcp__chrome-devtools__take_screenshot");
		assert.equal(mcpToolName("s", "x".repeat(100)).length, 64);
	});
});
