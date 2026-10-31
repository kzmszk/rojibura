declare module "*?raw" {
	const content: string;
	export default content;
}

// Enabled by the nodejs_als compatibility flag (cloudflare.config.ts); only what usage.ts needs.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		run<R>(store: T, fn: () => R): R;
		getStore(): T | undefined;
	}
}
