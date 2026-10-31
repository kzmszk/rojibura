// Browser runtime (T3, docs/prd.md 3.5.1): identity and memory in IndexedDB, and the host's trial LLM.

export {
	type BrowserIdentity,
	forgetBrowserIdentity,
	loadBrowserIdentity,
	registerBrowserAgent,
	saveBrowserIdentity,
} from "./identity.ts";
export { IdbMemory } from "./memory.ts";
export { HostTrialLLM, TrialLimitError, trialRemaining } from "./trial-llm.ts";
