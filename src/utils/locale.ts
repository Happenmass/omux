export type SupportedLocale = "zh-CN" | "en-US";

const ZH_PATTERN = /^zh/i;

/**
 * Resolve the active locale.
 * Priority: config override → LANG/LC_ALL env → en-US fallback.
 */
export function resolveLocale(configLocale?: string): SupportedLocale {
	if (configLocale) {
		return normalizeLocale(configLocale);
	}
	const env = process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || "";
	return normalizeLocale(env);
}

function normalizeLocale(raw: string): SupportedLocale {
	// Strip encoding suffix (e.g. "zh_CN.UTF-8" → "zh_CN")
	const base = raw.split(".")[0].replace("_", "-");
	return ZH_PATTERN.test(base) ? "zh-CN" : "en-US";
}

/** Language instruction snippet for LLM prompts */
export function getLanguageInstruction(locale: SupportedLocale): string {
	if (locale === "zh-CN") {
		return "All human-readable text MUST be written in Chinese (简体中文). File paths and code identifiers remain in their original form.";
	}
	return "All human-readable text MUST be written in English. File paths and code identifiers remain in their original form.";
}
