import { writeFileSync } from "node:fs";
import { ConfigFileSchema } from "./config.ts";

/** The JSON Schema editors use to autocomplete and check `config.json`. Regenerate with `npm run schema`. */
export function configJsonSchema(): string {
	const schema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "pi-durable-discord config.json",
		...ConfigFileSchema,
	};
	return `${JSON.stringify(schema, null, "\t")}\n`;
}

if (import.meta.main) {
	writeFileSync(new URL("../config.schema.json", import.meta.url), configJsonSchema());
	process.stdout.write("wrote config.schema.json\n");
}
