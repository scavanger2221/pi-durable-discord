import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { openAgent } from "./agent/open.ts";
import { StartupError } from "./agent/models.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createGateway } from "./discord/gateway.ts";
import { createLogger, errorSummary } from "./log.ts";

let log = createLogger();

async function main(): Promise<void> {
	const config = loadConfig();
	log = createLogger(config.logLevel);
	const agent = await openAgent(config, { log });
	const gateway = createGateway(config, agent, log);
	void agent.harness.closed.then((end) => {
		if (end.reason === "failed") {
			log.error("harness_failed", { error: errorSummary(end.error) });
			process.exit(1);
		}
	});
	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info("shutdown", { signal });
		await gateway.stop().catch(() => undefined);
		// Running tasks are written back as pending and continue on the next start.
		await agent.close(BG);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	await gateway.start();
	log.info("started", {
		model: `${config.provider}/${config.modelId}`,
		workdir: config.workdir,
		workspace: config.workspaceMode,
		data: config.dataDir,
		config: config.configFile ?? "environment only",
	});
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError) {
		// Readable, since it usually means editing config.json.
		process.stderr.write(`Configuration problem: ${error.message}\nRun \`npm run check\` for details, or \`npm run setup\` to create config.json.\n`);
		process.exit(2);
	}
	log.error("startup_failed", { error: errorSummary(error) });
	process.exit(error instanceof StartupError ? error.exitCode : error instanceof ConfigError ? 2 : 1);
});
