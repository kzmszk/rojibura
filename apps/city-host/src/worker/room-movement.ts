import { type HostToClient, polylineLength, WALK_SPEED } from "@rojibura/protocol";
import type { Member, Transport } from "./room-types.ts";

export class RoomMovement<C> {
	private readonly transport: Transport<C>;
	private readonly broadcastAbout: (member: Member, message: HostToClient, except?: C) => void;

	constructor(
		transport: Transport<C>,
		broadcastAbout: (member: Member, message: HostToClient, except?: C) => void,
	) {
		this.transport = transport;
		this.broadcastAbout = broadcastAbout;
	}

	commit(conn: C, member: Member, move: Member["move"]): void {
		member.move = move;
		this.transport.persist(conn, member);
		this.broadcastAbout(member, { t: "MOVED", id: member.id, move: member.move });
	}

	correct(conn: C, member: Member, move: Member["move"]): void {
		member.move = move;
		this.transport.persist(conn, member);
		this.transport.send(conn, { t: "CORRECT", move: member.move });
		this.broadcastAbout(member, { t: "MOVED", id: member.id, move: member.move }, conn);
	}

	liftPosture(conn: C, member: Member, move: Member["move"]): void {
		member.move = move;
		this.broadcastAbout(member, { t: "MOVED", id: member.id, move: member.move });
		this.transport.persist(conn, member);
	}

	approachSeat(
		conn: C,
		member: Member,
		path: Extract<Member["move"], { kind: "path" }>["path"] | null,
		seat: number,
		now: number,
	): void {
		if (path) {
			member.move = { kind: "path", path, speed: WALK_SPEED, at: now };
			this.broadcastAbout(member, { t: "MOVED", id: member.id, move: member.move });
		}
		const ms = path ? (polylineLength(path) / WALK_SPEED) * 1000 : 0;
		member.seatPlan = { seat, at: now + ms + 150 };
		this.transport.persist(conn, member);
	}
}
