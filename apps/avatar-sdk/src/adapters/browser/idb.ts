// A tiny promise wrapper over IndexedDB: one database, key-value stores.

const DB_NAME = "rojibura";
const STORES = ["agents", "memory"] as const;
export type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
	opening ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return opening;
}

function run<T>(store: Store, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const req = op(db.transaction(store, mode).objectStore(store));
				req.onsuccess = () => resolve(req.result as T);
				req.onerror = () => reject(req.error);
			}),
	);
}

export const idbGet = <T>(store: Store, key: string) =>
	run<T | undefined>(store, "readonly", (s) => s.get(key));
export const idbPut = (store: Store, key: string, value: unknown) =>
	run<IDBValidKey>(store, "readwrite", (s) => s.put(value, key)).then(() => {});
export const idbDelete = (store: Store, key: string) =>
	run<undefined>(store, "readwrite", (s) => s.delete(key)).then(() => {});
