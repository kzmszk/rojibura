import type { AvatarId, AvatarState, Doing } from "@rojibura/protocol";
import type * as THREE from "three";
import { AvatarView } from "./avatars.ts";

type Badge = { emoji: string; name: string; exercise?: boolean } | null;
type CityAvatar = Pick<AvatarView, "state" | "dispose" | "setDoing" | "setStatus" | "setFly">;
type AvatarFactory<V extends CityAvatar> = {
	create: (state: AvatarState, isMine: boolean) => V;
	attach: (view: V) => void;
};

export class CityAvatars<V extends CityAvatar> {
	private readonly views = new Map<AvatarId, V>();
	readonly avatars: ReadonlyMap<AvatarId, V> = this.views;

	private readonly factory: AvatarFactory<V>;
	private readonly badgeOf: (doing?: Doing | null) => Badge;

	constructor(factory: AvatarFactory<V>, badgeOf: (doing?: Doing | null) => Badge) {
		this.factory = factory;
		this.badgeOf = badgeOf;
	}

	add(state: AvatarState, you: AvatarId | null, blocked: ReadonlySet<AvatarId>): void {
		if (blocked.has(state.id)) return;
		this.views.get(state.id)?.dispose();
		const view = this.factory.create(state, state.id === you);
		this.views.set(state.id, view);
		this.factory.attach(view);
		view.setDoing(this.badgeOf(state.doing));
	}

	remove(id: AvatarId): void {
		this.views.get(id)?.dispose();
		this.views.delete(id);
	}

	reconcile(
		incoming: AvatarState[],
		you: AvatarId,
		blocked: ReadonlySet<AvatarId>,
		showFlying: (alt: number | null) => void,
		present: (id: AvatarId) => void,
	): void {
		const here = new Set(incoming.map((a) => a.id));
		for (const [id] of this.views) {
			if (!here.has(id)) this.remove(id);
		}
		for (const avatar of incoming) {
			const view = this.views.get(avatar.id);
			const same =
				view &&
				!blocked.has(avatar.id) &&
				view.state.name === avatar.name &&
				JSON.stringify(view.state.assets) === JSON.stringify(avatar.assets);
			if (view && same) {
				Object.assign(view.state, avatar);
				if (!avatar.doing) delete view.state.doing;
				view.setDoing(this.badgeOf(avatar.doing));
				view.setStatus(avatar.status);
			} else {
				this.remove(avatar.id);
				this.add(avatar, you, blocked);
			}
			this.views.get(avatar.id)?.setFly(avatar.fly ?? null);
			if (avatar.id === you) showFlying(avatar.fly ?? null);
			present(avatar.id);
		}
	}

	refreshBadges(): void {
		for (const view of this.views.values()) view.setDoing(this.badgeOf(view.state.doing));
	}
}

export function createCityAvatars(
	scene: THREE.Scene,
	badgeOf: (doing?: Doing | null) => Badge,
): CityAvatars<AvatarView> {
	return new CityAvatars(
		{
			create: (state, isMine) => new AvatarView(state, isMine),
			attach: (view) => scene.add(view.root),
		},
		badgeOf,
	);
}
