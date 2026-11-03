// The fuller look an area can ask for (AreaView.rich, はじまりの街, issue 42), after the VENEZIA demo: filmic tone
// mapping, the sky as the light that fills the shadows and as what shiny things reflect (a gradient sky with a
// sun, made into an environment map), and ambient occlusion that darkens corners, reveals and the ground along
// the walls (GTAO, not on phones and tablets).

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = normalize(position);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSun;
varying vec3 vDir;
void main() {
	vec3 d = normalize(vDir);
	float up = d.y;
	vec3 sky = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.55));
	vec3 col = up >= 0.0 ? sky : mix(uHorizon * 0.8, uGround, clamp(-up * 4.0, 0.0, 1.0));
	// the sun and its glow
	float s = max(dot(d, uSunDir), 0.0);
	col += uSun * (pow(s, 900.0) * 40.0 + pow(s, 12.0) * 0.35);
	gl_FragColor = vec4(col, 1.0);
}`;

export class RichLook {
	readonly composer: EffectComposer;
	private readonly ao: GTAOPass | null;
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene: THREE.Scene;
	private readonly pmrem: THREE.PMREMGenerator;
	private readonly sky = new THREE.Scene();
	private readonly skyMat: THREE.ShaderMaterial;
	private env: THREE.WebGLRenderTarget | null = null;

	constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ao: boolean) {
		this.renderer = renderer;
		this.scene = scene;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 0.95;
		this.pmrem = new THREE.PMREMGenerator(renderer);
		this.skyMat = new THREE.ShaderMaterial({
			vertexShader: SKY_VERTEX,
			fragmentShader: SKY_FRAGMENT,
			side: THREE.BackSide,
			depthWrite: false,
			uniforms: {
				uZenith: { value: new THREE.Color() },
				uHorizon: { value: new THREE.Color() },
				uGround: { value: new THREE.Color() },
				uSunDir: { value: new THREE.Vector3(0, 1, 0) },
				uSun: { value: new THREE.Color() },
			},
		});
		this.sky.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.skyMat));
		const size = renderer.getSize(new THREE.Vector2());
		this.composer = new EffectComposer(renderer);
		this.composer.addPass(new RenderPass(scene, camera));
		this.ao = ao ? new GTAOPass(scene, camera, size.x, size.y) : null;
		if (this.ao) {
			this.ao.updateGtaoMaterial({ radius: 2.5, distanceExponent: 2, thickness: 4, scale: 1.4, samples: 16 });
			this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
			this.ao.blendIntensity = 1.0;
			this.composer.addPass(this.ao);
		}
		this.composer.addPass(new OutputPass());
	}

	/**
	 * The sky: its colours (zenith, horizon, the ground below the horizon), and the sun's direction and colour.
	 * Becomes the background and the scene's environment light.
	 */
	setSky(
		zenith: THREE.Color,
		horizon: THREE.Color,
		ground: THREE.Color,
		sunDir: THREE.Vector3,
		sun: THREE.Color,
	): void {
		const u = this.skyMat.uniforms;
		(u.uZenith?.value as THREE.Color).copy(zenith);
		(u.uHorizon?.value as THREE.Color).copy(horizon);
		(u.uGround?.value as THREE.Color).copy(ground);
		(u.uSunDir?.value as THREE.Vector3).copy(sunDir).normalize();
		(u.uSun?.value as THREE.Color).copy(sun);
		this.env?.dispose();
		this.env = this.pmrem.fromScene(this.sky, 0, 0.1, 100);
		this.scene.environment = this.env.texture;
		this.scene.background = this.env.texture;
		this.scene.backgroundBlurriness = 0;
	}

	setSize(w: number, h: number): void {
		this.composer.setSize(w, h);
	}

	render(): void {
		this.composer.render();
	}

	dispose(): void {
		this.env?.dispose();
		this.pmrem.dispose();
		this.composer.dispose();
	}
}
