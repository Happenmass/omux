import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Isolates every test file from the real ~/.omux (see test/setup.ts).
		setupFiles: ["test/setup.ts"],
	},
});
