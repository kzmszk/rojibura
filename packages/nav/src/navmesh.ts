import type { Vec2 } from "./vec.ts";

/** The navmesh.json format version this library reads. */
export const NAVMESH_VERSION = 1;

/**
 * One convex polygon. `verts` index into `NavMeshData.vertices`; `neighbors[j]` is the polygon across the
 * edge `verts[j] -> verts[(j + 1) % n]`, or -1 if that edge is a wall (the border of the walkable area).
 * Either winding is accepted.
 */
export interface NavMeshPolygonData {
	verts: readonly number[];
	neighbors: readonly number[];
}

/** navmesh.json, written by tools/city-build. Coordinates are glTF world space (Y up, metres). */
export interface NavMeshData {
	/** Must be NAVMESH_VERSION. */
	version: number;
	/** Flat x, y, z. */
	vertices: readonly number[];
	polygons: readonly NavMeshPolygonData[];
}

export interface NavMeshOptions {
	/**
	 * Points this close to the walkable area (metres) count as on it. Absorbs float error and coordinates
	 * rounded to the centimetre on the wire. Default 0.01.
	 */
	tolerance?: number;
	/** Cell size of the point-location grid (metres). Default: derived from the polygon sizes. */
	gridCellSize?: number;
}

const DEFAULT_TOLERANCE = 0.01;
const MAX_GRID_CELLS = 1 << 20;
/** Points per portal (shared edge) that the A* search moves between: both ends and evenly spaced ones between. */
const PORTAL_SAMPLES = 5;

/**
 * Walkable area as convex polygons on the XZ plane, with A* + funnel path finding and point location
 * through a uniform grid. Pure TypeScript: runs unchanged in browsers, Workers and Node.
 *
 * Instances keep scratch buffers for the search; JS never runs two queries on one instance at once.
 */
export class NavMesh {
	/** Number of polygons. */
	readonly polygonCount: number;

	private readonly tolerance: number;
	// Vertices.
	private readonly vx: Float64Array;
	private readonly vy: Float64Array;
	private readonly vz: Float64Array;
	// Polygons in CSR form, wound counter-clockwise in (x, z): polygon i is entries first[i] .. first[i + 1] - 1.
	private readonly first: Int32Array;
	private readonly polyVert: Int32Array;
	private readonly polyNeighbor: Int32Array;
	private readonly edgeLength: Float64Array;
	private readonly minX: Float64Array;
	private readonly minZ: Float64Array;
	private readonly maxX: Float64Array;
	private readonly maxZ: Float64Array;
	/** Polygon each polyVert entry (edge) belongs to. */
	private readonly owner: Int32Array;
	private readonly component: Int32Array;
	// Point-location grid (CSR: cell c holds cellPoly[cellFirst[c] .. cellFirst[c + 1] - 1]).
	private readonly gridX: number;
	private readonly gridZ: number;
	private readonly gridCell: number;
	private readonly gridCols: number;
	private readonly gridRows: number;
	private readonly cellFirst: Int32Array;
	private readonly cellPoly: Int32Array;
	// Wall edges (ax, az, bx, bz) for closestPoint.
	private readonly walls: Float64Array;
	// A* states: sample s of edge k is state k * PORTAL_SAMPLES + s, at (stateX, stateZ).
	private readonly stateX: Float64Array;
	private readonly stateZ: Float64Array;
	// A* scratch, indexed by state. `seen` / `closed` hold the generation of the query that set them.
	private generation = 0;
	private readonly seen: Uint32Array;
	private readonly closed: Uint32Array;
	private readonly cost: Float64Array;
	private readonly parent: Int32Array;
	private heapState: Int32Array;
	private heapKey: Float64Array;

	/** Builds a navmesh from navmesh.json. Throws if the data is malformed. */
	static fromJSON(data: NavMeshData, options: NavMeshOptions = {}): NavMesh {
		if (typeof data !== "object" || data === null) throw new Error("navmesh: not an object");
		if (data.version !== NAVMESH_VERSION) throw new Error(`navmesh: unsupported version ${data.version}`);
		const { vertices, polygons } = data;
		if (!Array.isArray(vertices) || vertices.length % 3 !== 0) throw new Error("navmesh: bad vertices");
		if (!Array.isArray(polygons) || polygons.length === 0) throw new Error("navmesh: no polygons");
		const vertexCount = vertices.length / 3;
		const vx = new Float64Array(vertexCount);
		const vy = new Float64Array(vertexCount);
		const vz = new Float64Array(vertexCount);
		for (let i = 0; i < vertexCount; i++) {
			const x = vertices[i * 3];
			const y = vertices[i * 3 + 1];
			const z = vertices[i * 3 + 2];
			if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
				throw new Error(`navmesh: vertex ${i} is not finite`);
			}
			vx[i] = x;
			vy[i] = y;
			vz[i] = z;
		}
		const first = new Int32Array(polygons.length + 1);
		for (let p = 0; p < polygons.length; p++) {
			const poly = polygons[p];
			const n = poly?.verts?.length ?? 0;
			if (!poly || n < 3 || !Array.isArray(poly.neighbors) || poly.neighbors.length !== n) {
				throw new Error(`navmesh: polygon ${p} is malformed`);
			}
			first[p + 1] = (first[p] as number) + n;
		}
		const total = first[polygons.length] as number;
		const polyVert = new Int32Array(total);
		const polyNeighbor = new Int32Array(total);
		for (let p = 0; p < polygons.length; p++) {
			const { verts, neighbors } = polygons[p] as NavMeshPolygonData;
			const n = verts.length;
			let area = 0;
			for (let j = 0; j < n; j++) {
				const a = verts[j];
				const nb = neighbors[j];
				if (!Number.isInteger(a) || (a as number) < 0 || (a as number) >= vertexCount) {
					throw new Error(`navmesh: polygon ${p} has a bad vertex index`);
				}
				if (!Number.isInteger(nb) || (nb as number) < -1 || (nb as number) >= polygons.length || nb === p) {
					throw new Error(`navmesh: polygon ${p} has a bad neighbor index`);
				}
				const b = verts[(j + 1) % n] as number;
				area +=
					(vx[a as number] as number) * (vz[b] as number) - (vx[b] as number) * (vz[a as number] as number);
			}
			const base = first[p] as number;
			for (let j = 0; j < n; j++) {
				if (area >= 0) {
					polyVert[base + j] = verts[j] as number;
					polyNeighbor[base + j] = neighbors[j] as number;
				} else {
					// Reverse the winding. Edge j of the reversed polygon is edge n - 2 - j of the original.
					polyVert[base + j] = verts[n - 1 - j] as number;
					polyNeighbor[base + j] = neighbors[(2 * n - 2 - j) % n] as number;
				}
			}
		}
		return new NavMesh(vx, vy, vz, first, polyVert, polyNeighbor, options);
	}

	private constructor(
		vx: Float64Array,
		vy: Float64Array,
		vz: Float64Array,
		first: Int32Array,
		polyVert: Int32Array,
		polyNeighbor: Int32Array,
		options: NavMeshOptions,
	) {
		const count = first.length - 1;
		this.polygonCount = count;
		this.tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
		this.vx = vx;
		this.vy = vy;
		this.vz = vz;
		this.first = first;
		this.polyVert = polyVert;
		this.polyNeighbor = polyNeighbor;

		const total = polyVert.length;
		const states = total * PORTAL_SAMPLES;
		this.edgeLength = new Float64Array(total);
		this.owner = new Int32Array(total);
		this.stateX = new Float64Array(states);
		this.stateZ = new Float64Array(states);
		this.minX = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
		this.minZ = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
		this.maxX = new Float64Array(count).fill(Number.NEGATIVE_INFINITY);
		this.maxZ = new Float64Array(count).fill(Number.NEGATIVE_INFINITY);
		const walls: number[] = [];
		let areaSum = 0;
		for (let p = 0; p < count; p++) {
			const start = first[p] as number;
			const end = first[p + 1] as number;
			for (let k = start; k < end; k++) {
				const a = polyVert[k] as number;
				const b = polyVert[k + 1 < end ? k + 1 : start] as number;
				const ax = vx[a] as number;
				const az = vz[a] as number;
				const bx = vx[b] as number;
				const bz = vz[b] as number;
				this.edgeLength[k] = Math.hypot(bx - ax, bz - az);
				this.owner[k] = p;
				for (let s = 0; s < PORTAL_SAMPLES; s++) {
					const t = s / (PORTAL_SAMPLES - 1);
					this.stateX[k * PORTAL_SAMPLES + s] = ax + (bx - ax) * t;
					this.stateZ[k * PORTAL_SAMPLES + s] = az + (bz - az) * t;
				}
				if ((polyNeighbor[k] as number) < 0) walls.push(ax, az, bx, bz);
				if (ax < (this.minX[p] as number)) this.minX[p] = ax;
				if (az < (this.minZ[p] as number)) this.minZ[p] = az;
				if (ax > (this.maxX[p] as number)) this.maxX[p] = ax;
				if (az > (this.maxZ[p] as number)) this.maxZ[p] = az;
			}
			areaSum +=
				((this.maxX[p] as number) - (this.minX[p] as number)) *
				((this.maxZ[p] as number) - (this.minZ[p] as number));
		}
		this.walls = Float64Array.from(walls);

		// Connected components (union-find), so unreachable goals fail without a full search.
		const root = new Int32Array(count);
		for (let p = 0; p < count; p++) root[p] = p;
		const find = (p: number): number => {
			let r = p;
			while (root[r] !== r) r = root[r] as number;
			while (root[p] !== r) {
				const next = root[p] as number;
				root[p] = r;
				p = next;
			}
			return r;
		};
		for (let p = 0; p < count; p++) {
			for (let k = first[p] as number; k < (first[p + 1] as number); k++) {
				const nb = polyNeighbor[k] as number;
				if (nb >= 0) root[find(p)] = find(nb);
			}
		}
		this.component = new Int32Array(count);
		for (let p = 0; p < count; p++) this.component[p] = find(p);

		// Uniform grid over the polygons' bounding boxes (expanded by the tolerance).
		const tol = this.tolerance;
		let gx0 = Number.POSITIVE_INFINITY;
		let gz0 = Number.POSITIVE_INFINITY;
		let gx1 = Number.NEGATIVE_INFINITY;
		let gz1 = Number.NEGATIVE_INFINITY;
		for (let p = 0; p < count; p++) {
			gx0 = Math.min(gx0, (this.minX[p] as number) - tol);
			gz0 = Math.min(gz0, (this.minZ[p] as number) - tol);
			gx1 = Math.max(gx1, (this.maxX[p] as number) + tol);
			gz1 = Math.max(gz1, (this.maxZ[p] as number) + tol);
		}
		let cell = options.gridCellSize ?? Math.max(Math.sqrt(areaSum / count), 0.5);
		while (Math.ceil((gx1 - gx0) / cell) * Math.ceil((gz1 - gz0) / cell) > MAX_GRID_CELLS) cell *= 2;
		this.gridX = gx0;
		this.gridZ = gz0;
		this.gridCell = cell;
		this.gridCols = Math.max(1, Math.ceil((gx1 - gx0) / cell));
		this.gridRows = Math.max(1, Math.ceil((gz1 - gz0) / cell));
		const cellCount = this.gridCols * this.gridRows;
		this.cellFirst = new Int32Array(cellCount + 1);
		const forEachCell = (p: number, visit: (c: number) => void) => {
			const c0 = this.col((this.minX[p] as number) - tol);
			const c1 = this.col((this.maxX[p] as number) + tol);
			const r0 = this.row((this.minZ[p] as number) - tol);
			const r1 = this.row((this.maxZ[p] as number) + tol);
			for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r * this.gridCols + c);
		};
		for (let p = 0; p < count; p++) {
			forEachCell(p, (c) => {
				this.cellFirst[c + 1] = (this.cellFirst[c + 1] as number) + 1;
			});
		}
		for (let c = 0; c < cellCount; c++) {
			this.cellFirst[c + 1] = (this.cellFirst[c + 1] as number) + (this.cellFirst[c] as number);
		}
		this.cellPoly = new Int32Array(this.cellFirst[cellCount] as number);
		const fill = this.cellFirst.slice(0, cellCount);
		for (let p = 0; p < count; p++) {
			forEachCell(p, (c) => {
				this.cellPoly[fill[c] as number] = p;
				fill[c] = (fill[c] as number) + 1;
			});
		}

		this.seen = new Uint32Array(states);
		this.closed = new Uint32Array(states);
		this.cost = new Float64Array(states);
		this.parent = new Int32Array(states);
		this.heapState = new Int32Array(states + 1);
		this.heapKey = new Float64Array(states + 1);
	}

	/** True if `p` is inside a walkable polygon (within the tolerance). */
	isWalkable(p: Vec2): boolean {
		return this.locate(p[0], p[1]) >= 0;
	}

	/** Height (Y) of the walkable surface at `p`, interpolated from the polygon's vertices; null off the mesh. */
	heightAt(p: Vec2): number | null {
		const poly = this.locate(p[0], p[1]);
		if (poly < 0) return null;
		const { vx, vy, vz, polyVert } = this;
		const start = this.first[poly] as number;
		const end = this.first[poly + 1] as number;
		const a = polyVert[start] as number;
		const ax = vx[a] as number;
		const az = vz[a] as number;
		// Fan triangulation from the first vertex; take the triangle that contains p best.
		let best = Number.NEGATIVE_INFINITY;
		let height = vy[a] as number;
		for (let k = start + 1; k + 1 < end; k++) {
			const b = polyVert[k] as number;
			const c = polyVert[k + 1] as number;
			const bx = (vx[b] as number) - ax;
			const bz = (vz[b] as number) - az;
			const cx = (vx[c] as number) - ax;
			const cz = (vz[c] as number) - az;
			const px = p[0] - ax;
			const pz = p[1] - az;
			const det = bx * cz - bz * cx;
			if (det === 0) continue;
			const u = (px * cz - pz * cx) / det;
			const v = (bx * pz - bz * px) / det;
			const inside = Math.min(u, v, 1 - u - v);
			if (inside > best) {
				best = inside;
				height = (1 - u - v) * (vy[a] as number) + u * (vy[b] as number) + v * (vy[c] as number);
			}
		}
		return height;
	}

	/** `p` itself if it is walkable, otherwise the nearest point on the border of the walkable area. */
	closestPoint(p: Vec2): Vec2 {
		const [x, z] = p;
		if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError("closestPoint: point is not finite");
		if (this.locate(x, z) >= 0) return [x, z];
		const w = this.walls;
		let bestX = x;
		let bestZ = z;
		let bestD = Number.POSITIVE_INFINITY;
		for (let i = 0; i < w.length; i += 4) {
			const ax = w[i] as number;
			const az = w[i + 1] as number;
			const dx = (w[i + 2] as number) - ax;
			const dz = (w[i + 3] as number) - az;
			const len2 = dx * dx + dz * dz;
			const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
			const qx = ax + dx * t;
			const qz = az + dz * t;
			const d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
			if (d < bestD) {
				bestD = d;
				bestX = qx;
				bestZ = qz;
			}
		}
		return [bestX, bestZ];
	}

	/**
	 * Shortest-ish walkable polyline from `from` to `to` (A* over polygons, then the funnel algorithm).
	 * Includes both end points. Null if either point is off the mesh or `to` cannot be reached.
	 */
	findPath(from: Vec2, to: Vec2): Vec2[] | null {
		const start = this.locate(from[0], from[1]);
		const goal = this.locate(to[0], to[1]);
		if (start < 0 || goal < 0 || this.component[start] !== this.component[goal]) return null;
		if (start === goal) {
			return [
				[from[0], from[1]],
				[to[0], to[1]],
			];
		}
		const corridor = this.search(start, goal, from, to);
		return corridor ? this.stringPull(from, to, corridor) : null;
	}

	/** Index of a polygon containing (x, z), or -1. */
	private locate(x: number, z: number): number {
		if (!(x >= this.gridX && z >= this.gridZ)) return -1; // also rejects NaN
		const c = Math.floor((x - this.gridX) / this.gridCell);
		const r = Math.floor((z - this.gridZ) / this.gridCell);
		if (c >= this.gridCols || r >= this.gridRows) return -1;
		const cell = r * this.gridCols + c;
		const end = this.cellFirst[cell + 1] as number;
		for (let i = this.cellFirst[cell] as number; i < end; i++) {
			const p = this.cellPoly[i] as number;
			if (this.contains(p, x, z)) return p;
		}
		return -1;
	}

	private contains(p: number, x: number, z: number): boolean {
		const tol = this.tolerance;
		if (
			x < (this.minX[p] as number) - tol ||
			x > (this.maxX[p] as number) + tol ||
			z < (this.minZ[p] as number) - tol ||
			z > (this.maxZ[p] as number) + tol
		) {
			return false;
		}
		const { vx, vz, polyVert } = this;
		const start = this.first[p] as number;
		const end = this.first[p + 1] as number;
		for (let k = start; k < end; k++) {
			const a = polyVert[k] as number;
			const b = polyVert[k + 1 < end ? k + 1 : start] as number;
			const ax = vx[a] as number;
			const az = vz[a] as number;
			// Counter-clockwise winding: inside is to the left of every edge.
			const cross = ((vx[b] as number) - ax) * (z - az) - ((vz[b] as number) - az) * (x - ax);
			if (cross < -tol * (this.edgeLength[k] as number)) return false;
		}
		return true;
	}

	private col(x: number): number {
		return Math.min(this.gridCols - 1, Math.max(0, Math.floor((x - this.gridX) / this.gridCell)));
	}

	private row(z: number): number {
		return Math.min(this.gridRows - 1, Math.max(0, Math.floor((z - this.gridZ) / this.gridCell)));
	}

	/**
	 * A* from `from` to `to` through the polygon graph. The search moves between points sampled on the
	 * portals (both ends and PORTAL_SAMPLES - 2 points in between), so a state's cost is the length of a
	 * walkable polyline. Paths bend at portal ends (corners), so this ranks corridors close to their
	 * string-pulled length; plain edge midpoints (Detour's choice) pick visibly longer corridors through
	 * large polygons. Returns the corridor as pairs (polygon being left, index into polyVert of the edge
	 * crossed), or null.
	 */
	private search(start: number, goal: number, from: Vec2, to: Vec2): number[] | null {
		if (this.generation === 0xffffffff) {
			this.generation = 0;
			this.seen.fill(0);
			this.closed.fill(0);
		}
		const gen = ++this.generation;
		const { polyNeighbor, first, owner, stateX, stateZ, seen, closed, cost, parent } = this;
		const [tx, tz] = to;
		let size = 0;
		const push = (state: number, key: number) => {
			if (size === this.heapState.length) {
				const states = new Int32Array(size * 2);
				const keys = new Float64Array(size * 2);
				states.set(this.heapState);
				keys.set(this.heapKey);
				this.heapState = states;
				this.heapKey = keys;
			}
			const heapState = this.heapState;
			const heapKey = this.heapKey;
			let i = size++;
			while (i > 0) {
				const up = (i - 1) >> 1;
				if ((heapKey[up] as number) <= key) break;
				heapState[i] = heapState[up] as number;
				heapKey[i] = heapKey[up] as number;
				i = up;
			}
			heapState[i] = state;
			heapKey[i] = key;
		};
		const pop = (): number => {
			const heapState = this.heapState;
			const heapKey = this.heapKey;
			const top = heapState[0] as number;
			const lastState = heapState[--size] as number;
			const lastKey = heapKey[size] as number;
			let i = 0;
			for (;;) {
				let child = 2 * i + 1;
				if (child >= size) break;
				if (child + 1 < size && (heapKey[child + 1] as number) < (heapKey[child] as number)) child++;
				if ((heapKey[child] as number) >= lastKey) break;
				heapState[i] = heapState[child] as number;
				heapKey[i] = heapKey[child] as number;
				i = child;
			}
			heapState[i] = lastState;
			heapKey[i] = lastKey;
			return top;
		};
		/** Moves from (x, z) inside `poly` (with cost g so far) to every sample of its portals. */
		const expand = (poly: number, x: number, z: number, g: number, parentState: number, back: number) => {
			const end = first[poly + 1] as number;
			for (let k = first[poly] as number; k < end; k++) {
				const next = polyNeighbor[k] as number;
				if (next < 0 || next === back) continue;
				for (let state = k * PORTAL_SAMPLES; state < (k + 1) * PORTAL_SAMPLES; state++) {
					if (closed[state] === gen) continue;
					const sx = stateX[state] as number;
					const sz = stateZ[state] as number;
					let c = g + Math.sqrt((sx - x) * (sx - x) + (sz - z) * (sz - z));
					const remaining = Math.sqrt((tx - sx) * (tx - sx) + (tz - sz) * (tz - sz));
					if (next === goal) c += remaining; // the cost of a goal state is the whole length
					if (seen[state] === gen && c >= (cost[state] as number)) continue;
					seen[state] = gen;
					cost[state] = c;
					parent[state] = parentState;
					push(state, next === goal ? c : c + remaining);
				}
			}
		};
		expand(start, from[0], from[1], 0, -1, -1);
		let found = -1;
		while (size > 0) {
			const state = pop();
			if (closed[state] === gen) continue;
			const edge = (state / PORTAL_SAMPLES) | 0;
			const poly = polyNeighbor[edge] as number;
			if (poly === goal) {
				found = state;
				break;
			}
			closed[state] = gen;
			expand(
				poly,
				stateX[state] as number,
				stateZ[state] as number,
				cost[state] as number,
				state,
				owner[edge] as number,
			);
		}
		if (found < 0) return null;
		const edges: number[] = [];
		for (let state = found; state >= 0; state = parent[state] as number)
			edges.push((state / PORTAL_SAMPLES) | 0);
		edges.reverse();
		// Zero-length moves around a shared corner can, in theory, revisit a polygon; cut such loops.
		const polys = [start];
		const crossed: number[] = [];
		for (const edge of edges) {
			const next = polyNeighbor[edge] as number;
			const seenAt = polys.indexOf(next);
			if (seenAt >= 0) {
				polys.length = seenAt + 1;
				crossed.length = seenAt;
			} else {
				polys.push(next);
				crossed.push(edge);
			}
		}
		const corridor: number[] = [];
		for (let i = 0; i < crossed.length; i++) corridor.push(polys[i] as number, crossed[i] as number);
		return corridor;
	}

	/** Funnel algorithm (string pulling) through the corridor from search(). */
	private stringPull(from: Vec2, to: Vec2, corridor: number[]): Vec2[] {
		const { vx, vz, polyVert, first } = this;
		// Portals: index 0 is the start point, the last is the end point. Seen from the polygon being left
		// (counter-clockwise), its edge a -> b has a on the right and b on the left.
		const count = corridor.length / 2 + 2;
		const lx = new Float64Array(count);
		const lz = new Float64Array(count);
		const rx = new Float64Array(count);
		const rz = new Float64Array(count);
		lx[0] = rx[0] = from[0];
		lz[0] = rz[0] = from[1];
		lx[count - 1] = rx[count - 1] = to[0];
		lz[count - 1] = rz[count - 1] = to[1];
		for (let i = 1; i < count - 1; i++) {
			const p = corridor[2 * i - 2] as number;
			const k = corridor[2 * i - 1] as number;
			const a = polyVert[k] as number;
			const b = polyVert[k + 1 < (first[p + 1] as number) ? k + 1 : (first[p] as number)] as number;
			rx[i] = vx[a] as number;
			rz[i] = vz[a] as number;
			lx[i] = vx[b] as number;
			lz[i] = vz[b] as number;
		}

		const path: Vec2[] = [[from[0], from[1]]];
		const add = (x: number, z: number) => {
			const last = path[path.length - 1] as Vec2;
			if (!sameish(last[0], last[1], x, z)) path.push([x, z]);
		};
		let apexX = from[0];
		let apexZ = from[1];
		let leftX = apexX;
		let leftZ = apexZ;
		let rightX = apexX;
		let rightZ = apexZ;
		let apexIndex = 0;
		let leftIndex = 0;
		let rightIndex = 0;
		for (let i = 1; i < count; i++) {
			const plx = lx[i] as number;
			const plz = lz[i] as number;
			const prx = rx[i] as number;
			const prz = rz[i] as number;
			// Right side: does the new right point narrow the funnel?
			if (cross(apexX, apexZ, rightX, rightZ, prx, prz) >= 0) {
				if (sameish(apexX, apexZ, rightX, rightZ) || cross(apexX, apexZ, leftX, leftZ, prx, prz) < 0) {
					rightX = prx;
					rightZ = prz;
					rightIndex = i;
				} else {
					// It crosses the left side: the left point is a corner of the path.
					add(leftX, leftZ);
					apexX = rightX = leftX;
					apexZ = rightZ = leftZ;
					apexIndex = rightIndex = leftIndex;
					i = apexIndex;
					continue;
				}
			}
			// Left side.
			if (cross(apexX, apexZ, leftX, leftZ, plx, plz) <= 0) {
				if (sameish(apexX, apexZ, leftX, leftZ) || cross(apexX, apexZ, rightX, rightZ, plx, plz) > 0) {
					leftX = plx;
					leftZ = plz;
					leftIndex = i;
				} else {
					add(rightX, rightZ);
					apexX = leftX = rightX;
					apexZ = leftZ = rightZ;
					apexIndex = leftIndex = rightIndex;
					i = apexIndex;
				}
			}
		}
		add(to[0], to[1]);
		if (path.length === 1) path.push([to[0], to[1]]);
		return path;
	}
}

/** > 0 if (bx, bz) is to the left of (counter-clockwise from) the ray o -> a. */
function cross(ox: number, oz: number, ax: number, az: number, bx: number, bz: number): number {
	return (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
}

function sameish(ax: number, az: number, bx: number, bz: number): boolean {
	const dx = ax - bx;
	const dz = az - bz;
	return dx * dx + dz * dz < 1e-12;
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}
