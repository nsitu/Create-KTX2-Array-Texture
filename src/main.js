import './style.css'

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeUASTCKTX2ToArray } from './ktx2ArrayMerge.js';


const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 10);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;


// --- Replace your "Load the texture" block with everything below ---

const ktxUrls = [
    './city.ktx2',
    './leaves.ktx2',
    './sunflower.ktx2',
    './trees.ktx2'
];

let cube;
let layerCount = 1;  // will update after load
let startTime = performance.now();
let mergedBufferAB = null; // store merged KTX2 for download

function setupDownloadButton() {
    const btn = document.createElement('button');
    btn.textContent = 'Download merged .ktx2';
    btn.style.position = 'absolute';
    btn.style.top = '10px';
    btn.style.left = '10px';
    btn.style.zIndex = '10';
    btn.style.padding = '8px 12px';
    btn.style.fontSize = '14px';
    btn.disabled = true; // enable when buffer ready

    btn.addEventListener('click', () => {
        if (!mergedBufferAB) return;
        const blob = new Blob([mergedBufferAB], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const name = `texture-array-${layerCount}layers.ktx2`;
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });

    document.body.appendChild(btn);
    return btn;
}

async function loadMergedKTX2Array(urls) {
    const bufs = await Promise.all(
        urls.map(async (u) => (await fetch(u)).arrayBuffer())
    );
    return mergeUASTCKTX2ToArray(bufs);
}

(async () => {
    if (renderer.capabilities.isWebGL2 !== true) {
        console.error('This demo needs WebGL2 for sampler2DArray.');
        return;
    }

    const downloadBtn = setupDownloadButton();

    mergedBufferAB = await loadMergedKTX2Array(ktxUrls);
    // Keep a copy for parsing to avoid detaching our stored buffer when sent to the worker
    const parseBuffer = mergedBufferAB.slice(0);
    downloadBtn.disabled = false;

    const ktx2 = new KTX2Loader()
        // Vite serves files from /public at the root path
        .setTranscoderPath('./')
        .detectSupport(renderer);

    ktx2.parse(
        parseBuffer,
        (arrayTex) => {
            arrayTex.anisotropy = 4;
            arrayTex.needsUpdate = true;

            layerCount = arrayTex.depth || arrayTex.image?.depth || 1;

            const material = new THREE.ShaderMaterial({
                glslVersion: THREE.GLSL3,
                uniforms: {
                    uTex: { value: arrayTex },
                    uLayer: { value: 0 }, // will update each frame
                },
                vertexShader: /* glsl */`
                    out vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: /* glsl */`
          precision highp float;
          precision highp sampler2DArray;

          in vec2 vUv;
          uniform sampler2DArray uTex;
          uniform int uLayer;
          out vec4 outColor;

          void main() {
            outColor = texture(uTex, vec3(vUv, float(uLayer)));
          }
        `,
            });

            const geometry = new THREE.BoxGeometry(2, 2, 2);
            cube = new THREE.Mesh(geometry, material);
            scene.add(cube);
        },
        (err) => console.error('KTX2 parse failed:', err)
    );
})();


// Animation loop
function animate() {
    requestAnimationFrame(animate);

    if (cube) {
        // Rotate cube
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;

        // NEW: cycle through layers once per second
        const elapsed = (performance.now() - startTime) / 1000.0; // seconds
        const currentLayer = Math.floor(elapsed) % layerCount;
        cube.material.uniforms.uLayer.value = currentLayer;
    }

    controls.update();
    renderer.render(scene, camera);
}


// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start the animation
animate();