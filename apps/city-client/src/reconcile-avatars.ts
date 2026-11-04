import type { AvatarId, AvatarState, Doing } from "@rojibura/protocol";
import type { AvatarView } from "./avatars.ts";

type Badge = { emoji: string; name: string; exercise?: boolean } | null;

export function reconcileAvatars(
	avatars: Map<AvatarId, AvatarView>,
	incoming: AvatarState[],
	you: AvatarId,
	blocked: ReadonlySet<AvatarId>,
	add: (avatar: AvatarState) => void,
	badgeOf: (doing?: Doing | null) => Badge,
	showFlying: (alt: number | null) => void,
	present: (id: AvatarId) => void,
): void {
	const here = new Set(incoming.map((a) => a.id));
	for (const [id, view] of avatars) {
		if (!here.has(id)) {
			view.dispose();
			avatars.delete(id);
		}
	}
	for (const avatar of incoming) {
		const view = avatars.get(avatar.id);
		const same =
			view &&
			!blocked.has(avatar.id) &&
			view.state.name === avatar.name &&
			JSON.stringify(view.state.assets) === JSON.stringify(avatar.assets);
		if (view && same) {
			Object.assign(view.state, avatar);
			if (!avatar.doing) delete view.state.doing;
			view.setDoing(badgeOf(avatar.doing));
			view.setStatus(avatar.status);
		} else {
			view?.dispose();
			avatars.delete(avatar.id);
			add(avatar);
		}
		avatars.get(avatar.id)?.setFly(avatar.fly ?? null);
		if (avatar.id === you) showFlying(avatar.fly ?? null);
		present(avatar.id);
	}
}
