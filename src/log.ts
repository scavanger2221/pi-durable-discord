type Fields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

export type Logger = Record<Level, (event: string, fields?: Fields) => void>;

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One JSON line per event on stderr, at `LOG_LEVEL` (default info) and above. */
export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
	const min = ORDER[level as Level] ?? ORDER.info;
	const write = (at: Level) => (event: string, fields: Fields = {}) => {
		if (ORDER[at] < min) return;
		process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: at, event, ...fields })}\n`);
	};
	return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function errorSummary(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
