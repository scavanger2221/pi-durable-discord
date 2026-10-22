import type { Message } from "@earendil-works/pi-ai";

/** Discord's message content limit. */
export const MESSAGE_LIMIT = 2000;
/** Room left in a chunk for a fence closed at its end and reopened in the next one. */
const FENCE_RESERVE = 24;

/**
 * Split Markdown into messages of at most `limit` characters, preferring paragraph, then line, then word breaks. A
 * code block cut between chunks is closed at the end of one and reopened, with its language, at the start of the next.
 */
export function splitForDiscord(text: string, limit = MESSAGE_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	let reopen = "";
	while (rest !== "") {
		const budget = limit - reopen.length - FENCE_RESERVE;
		if (reopen.length + rest.length <= limit) {
			chunks.push(reopen + rest);
			break;
		}
		const cut = breakAt(rest, budget);
		let body = reopen + rest.slice(0, cut).trimEnd();
		rest = rest.slice(cut).replace(/^\n+/, "");
		const open = openFence(body);
		if (open !== undefined) {
			body += "\n```";
			reopen = `${open}\n`;
		} else reopen = "";
		chunks.push(body);
	}
	return chunks.length === 0 ? [] : chunks;
}

function breakAt(text: string, budget: number): number {
	const window = text.slice(0, budget);
	for (const separator of ["\n\n", "\n", " "]) {
		const index = window.lastIndexOf(separator);
		if (index > budget / 2) return index + separator.length;
	}
	return budget;
}

/** The opening line of the code fence left open at the end of `text`, if any. */
export function openFence(text: string): string | undefined {
	let open: string | undefined;
	for (const line of text.split("\n")) {
		const match = /^\s*(```+|~~~+)(.*)$/.exec(line);
		if (match === null) continue;
		if (open === undefined) open = `${match[1]}${(match[2] ?? "").trim()}`;
		else if (open.startsWith(match[1] as string) && (match[2] ?? "").trim() === "") open = undefined;
	}
	return open;
}

/** The last `max` characters of `text`, starting at a line break when one is near. */
export function tail(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(text.length - max);
	const newline = cut.indexOf("\n");
	return newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut;
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The user-visible text of a final answer: text parts of a stop/length answer without tool calls. */
export function finalReplyText(message: Message | undefined): string | undefined {
	if (message?.role !== "assistant" || !["stop", "length"].includes(message.stopReason)) return undefined;
	if (message.content.some((part) => part.type === "toolCall")) return undefined;
	const text = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
	return text === "" ? undefined : text;
}
