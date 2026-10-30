import { PROTOCOL_VERSION } from "@rojibura/protocol";

/** Mounts the city viewer into `root` (issue #18). */
export function mountApp(root: HTMLElement): void {
	root.textContent = `rojibura (protocol v${PROTOCOL_VERSION})`;
}
