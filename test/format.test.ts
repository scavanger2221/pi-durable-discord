import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripMention, threadName } from "../src/discord/content.ts";
import { renderPreview, withFiles } from "../src/discord/deliver.ts";
import { MESSAGE_LIMIT, openFence, splitForDiscord } from "../src/discord/format.ts";

describe("splitForDiscord", () => {
	it("keeps short text as one message", () => {
		assert.deepEqual(splitForDiscord("hello"), ["hello"]);
	});

	it("splits long text within the limit, closing and reopening code fences", () => {
		const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n");
		const chunks = splitForDiscord(`Intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro`);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.length <= MESSAGE_LIMIT, `chunk of ${chunk.length}`);
			assert.equal(openFence(chunk), undefined, "every chunk closes its fences");
		}
		assert.ok(chunks[1]?.startsWith("```ts\n"));
		assert.ok(chunks.at(-1)?.endsWith("Outro"));
	});
});

describe("helpers", () => {
	it("strips the bot mention and names threads", () => {
		assert.equal(stripMention("<@123> fix the build <@!123>", "123"), "fix the build");
		assert.equal(threadName("  "), "pi task");
		assert.equal(threadName("a".repeat(200)).length, 90);
	});

	it("previews streamed text and running tools", () => {
		assert.equal(renderPreview({}), "-# ⏳ working…");
		const live = {
			generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Looking" }] } },
			tools: [{ callId: "1", name: "bash", status: "running" }],
		} as never;
		assert.equal(renderPreview(live), "Looking\n\n-# ⚙ bash");
	});
});

describe("withFiles", () => {
	const file = (n: number) => ({ path: `/tmp/${n}`, name: `${n}.png` });

	it("puts files on the last chunk and overflows past Discord's 10 per message", () => {
		const files = Array.from({ length: 12 }, (_, i) => file(i));
		const messages = withFiles(["a", "b"], files);
		assert.deepEqual(
			messages.map((each) => [each.text, each.files.length]),
			[["a", 0], ["b", 10], ["", 2]],
		);
	});

	it("posts files alone when there is no text", () => {
		assert.deepEqual(withFiles([], [file(1)]), [{ text: "", files: [file(1)] }]);
	});
});
