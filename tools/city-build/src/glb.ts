// Minimal glb reader: enough of glTF 2.0 to collect world-space triangles and marker nodes.
// Supports node hierarchies (matrix or TRS), indexed and non-indexed triangle lists and
// interleaved buffer views. Compressed or quantised geometry (Draco, meshopt, ...) is rejected.

/** Column-major 4x4 matrix, as in glTF. */
export type Mat4 = Float64Array;

export interface GltfNode {
	name?: string;
	children?: number[];
	mesh?: number;
	matrix?: number[];
	translation?: [number, number, number];
	rotation?: [number, number, number, number];
	scale?: [number, number, number];
	extras?: Record<string, unknown>;
}

interface GltfAccessor {
	bufferView?: number;
	byteOffset?: number;
	componentType: number;
	normalized?: boolean;
	count: number;
	type: string;
	sparse?: unknown;
}

interface GltfBufferView {
	buffer: number;
	byteOffset?: number;
	byteLength: number;
	byteStride?: number;
}

interface GltfPrimitive {
	attributes: Record<string, number>;
	indices?: number;
	mode?: number;
}

export interface GltfJson {
	asset: { version: string };
	scene?: number;
	scenes?: { nodes?: number[] }[];
	nodes?: GltfNode[];
	meshes?: { name?: string; primitives: GltfPrimitive[] }[];
	accessors?: GltfAccessor[];
	bufferViews?: GltfBufferView[];
	buffers?: { byteLength: number; uri?: string }[];
	extensionsRequired?: string[];
}

export interface Glb {
	json: GltfJson;
	bin: Uint8Array | undefined;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export function parseGlb(data: Uint8Array): Glb {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a glb file");
	const version = view.getUint32(4, true);
	if (version !== 2) throw new Error(`unsupported glb version ${version}`);
	const length = Math.min(view.getUint32(8, true), data.byteLength);
	let json: GltfJson | undefined;
	let bin: Uint8Array | undefined;
	for (let offset = 12; offset + 8 <= length; ) {
		const chunkLength = view.getUint32(offset, true);
		const chunkType = view.getUint32(offset + 4, true);
		const chunk = data.subarray(offset + 8, offset + 8 + chunkLength);
		if (chunkType === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
		else if (chunkType === CHUNK_BIN && bin === undefined) bin = chunk;
		offset += 8 + chunkLength;
	}
	if (!json) throw new Error("glb has no JSON chunk");
	if (json.extensionsRequired?.length) {
		throw new Error(`unsupported required glTF extensions: ${json.extensionsRequired.join(", ")}`);
	}
	return { json, bin };
}

export function identity(): Mat4 {
	const m = new Float64Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float64Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

/** Local transform of a node (matrix, or T * R * S). */
export function localMatrix(node: GltfNode): Mat4 {
	if (node.matrix) return Float64Array.from(node.matrix);
	const [tx, ty, tz] = node.translation ?? [0, 0, 0];
	const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
	const [sx, sy, sz] = node.scale ?? [1, 1, 1];
	const m = new Float64Array(16);
	m[0] = (1 - 2 * (y * y + z * z)) * sx;
	m[1] = 2 * (x * y + z * w) * sx;
	m[2] = 2 * (x * z - y * w) * sx;
	m[4] = 2 * (x * y - z * w) * sy;
	m[5] = (1 - 2 * (x * x + z * z)) * sy;
	m[6] = 2 * (y * z + x * w) * sy;
	m[8] = 2 * (x * z + y * w) * sz;
	m[9] = 2 * (y * z - x * w) * sz;
	m[10] = (1 - 2 * (x * x + y * y)) * sz;
	m[12] = tx;
	m[13] = ty;
	m[14] = tz;
	m[15] = 1;
	return m;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
	return [
		(m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
		(m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
		(m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
	];
}

/** Determinant of the upper-left 3x3 block (negative = the transform mirrors). */
function determinant3(m: Mat4): number {
	const at = (i: number) => m[i] as number;
	return (
		at(0) * (at(5) * at(10) - at(6) * at(9)) -
		at(4) * (at(1) * at(10) - at(2) * at(9)) +
		at(8) * (at(1) * at(6) - at(2) * at(5))
	);
}

export interface SceneNode {
	index: number;
	node: GltfNode;
	world: Mat4;
}

/** Visits every node of the default scene (depth first) with its world matrix. */
export function sceneNodes(glb: Glb): SceneNode[] {
	const { json } = glb;
	const nodes = json.nodes ?? [];
	const scene = json.scenes?.[json.scene ?? 0];
	const roots = scene?.nodes ?? nodes.map((_, i) => i);
	const out: SceneNode[] = [];
	const visit = (index: number, parent: Mat4, depth: number) => {
		const node = nodes[index];
		if (!node) throw new Error(`missing node ${index}`);
		if (depth > 256) throw new Error("node hierarchy too deep (cycle?)");
		const world = multiply(parent, localMatrix(node));
		out.push({ index, node, world });
		for (const child of node.children ?? []) visit(child, world, depth + 1);
	};
	for (const root of roots) visit(root, identity(), 0);
	return out;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Reads an accessor into a flat array of numbers (no normalisation). */
export function readAccessor(glb: Glb, index: number): Float64Array {
	const accessor = glb.json.accessors?.[index];
	if (!accessor) throw new Error(`missing accessor ${index}`);
	if (accessor.sparse) throw new Error(`sparse accessors are not supported (accessor ${index})`);
	if (accessor.normalized) throw new Error(`normalized accessors are not supported (accessor ${index})`);
	const components = COMPONENTS[accessor.type];
	const size = COMPONENT_BYTES[accessor.componentType];
	if (!components || !size) throw new Error(`unsupported accessor layout (accessor ${index})`);
	const out = new Float64Array(accessor.count * components);
	if (accessor.bufferView === undefined) return out; // all zeros by spec
	const bufferView = glb.json.bufferViews?.[accessor.bufferView];
	if (!bufferView) throw new Error(`missing bufferView ${accessor.bufferView}`);
	if (bufferView.buffer !== 0 || !glb.bin) throw new Error("only the glb BIN chunk is supported as a buffer");
	const stride = bufferView.byteStride ?? components * size;
	const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
	const end = base + stride * (accessor.count - 1) + components * size;
	if (end > (bufferView.byteOffset ?? 0) + bufferView.byteLength || end > glb.bin.byteLength) {
		throw new Error(`accessor ${index} is out of bounds`);
	}
	const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
	for (let i = 0; i < accessor.count; i++) {
		for (let c = 0; c < components; c++) {
			const at = base + i * stride + c * size;
			let value: number;
			switch (accessor.componentType) {
				case 5120:
					value = view.getInt8(at);
					break;
				case 5121:
					value = view.getUint8(at);
					break;
				case 5122:
					value = view.getInt16(at, true);
					break;
				case 5123:
					value = view.getUint16(at, true);
					break;
				case 5125:
					value = view.getUint32(at, true);
					break;
				default:
					value = view.getFloat32(at, true);
			}
			out[i * components + c] = value;
		}
	}
	return out;
}

export interface TriangleSoup {
	/** Flat x, y, z world-space positions. */
	positions: Float32Array;
	/** Three vertex indices per triangle. */
	indices: Uint32Array;
}

/**
 * Collects every triangle of every mesh in the default scene, in world space.
 * `include` can skip nodes by name (for example decorative meshes that should not block walking).
 */
export function collectTriangles(glb: Glb, include: (node: GltfNode) => boolean = () => true): TriangleSoup {
	const positions: number[] = [];
	const indices: number[] = [];
	for (const { node, world } of sceneNodes(glb)) {
		if (node.mesh === undefined || !include(node)) continue;
		const mesh = glb.json.meshes?.[node.mesh];
		if (!mesh) throw new Error(`missing mesh ${node.mesh}`);
		for (const primitive of mesh.primitives) {
			const mode = primitive.mode ?? 4;
			if (mode !== 4) continue; // points, lines, strips and fans do not occur in our exports
			const position = primitive.attributes.POSITION;
			if (position === undefined) continue;
			const local = readAccessor(glb, position);
			const first = positions.length / 3;
			for (let i = 0; i < local.length; i += 3) {
				positions.push(
					...transformPoint(world, local[i] as number, local[i + 1] as number, local[i + 2] as number),
				);
			}
			const count = local.length / 3;
			const tri = primitive.indices === undefined ? undefined : readAccessor(glb, primitive.indices);
			const n = tri ? tri.length : count;
			// A mirroring transform flips the winding, and Recast decides "up" from the winding.
			const order = determinant3(world) < 0 ? [0, 2, 1] : [0, 1, 2];
			for (let i = 0; i + 2 < n; i += 3) {
				for (const k of order) {
					const v = tri ? (tri[i + k] as number) : i + k;
					if (v >= count) throw new Error(`index out of range in mesh ${mesh.name ?? node.mesh}`);
					indices.push(first + v);
				}
			}
		}
	}
	return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
