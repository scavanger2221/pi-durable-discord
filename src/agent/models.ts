import {
	type Api,
	type CredentialStore,
	createModels,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export class StartupError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "StartupError";
		this.exitCode = exitCode;
	}
}

/** Models with the configured built-in provider registered and credentials from `credentials`. */
export function createAgentModels(provider: string, credentials: CredentialStore): MutableModels {
	const found = builtinProviders().find((each) => each.id === provider);
	if (found === undefined) {
		const known = builtinProviders()
			.map((each) => each.id)
			.join(", ");
		throw new StartupError(`PI_PROVIDER: unknown provider ${JSON.stringify(provider)}. Known: ${known}`, 2);
	}
	const models = createModels({ credentials });
	models.setProvider(found);
	return models;
}

/** The configured model, with the thinking level checked against what it supports. */
export function resolveModel(
	models: MutableModels,
	ref: { provider: string; modelId: string },
	thinkingLevel: ModelThinkingLevel,
): Model<Api> {
	const model = models.getModel(ref.provider, ref.modelId);
	if (model === undefined) {
		const known = models
			.getModels(ref.provider)
			.map((each) => each.id)
			.slice(0, 20)
			.join(", ");
		throw new StartupError(`PI_MODEL: ${ref.provider}/${ref.modelId} is unknown. Known: ${known}`, 2);
	}
	const supported = model.reasoning ? getSupportedThinkingLevels(model) : (["off"] as ModelThinkingLevel[]);
	if (!supported.includes(thinkingLevel)) {
		throw new StartupError(
			`PI_THINKING: ${thinkingLevel} is not supported by ${model.id}; use one of ${supported.join(", ")}`,
			2,
		);
	}
	return model;
}
