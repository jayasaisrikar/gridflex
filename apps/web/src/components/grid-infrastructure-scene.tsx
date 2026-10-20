'use client';

import { useEffect, useRef, useState } from 'react';

const modes = [
  { id: 'telemetry', label: 'Telemetry', detail: 'Read-only signals' },
  { id: 'envelope', label: 'Envelope', detail: '0.49 MW tested' },
  { id: 'drill', label: 'Drill', detail: '98% delivered' },
  { id: 'passport', label: 'Passport', detail: 'Evidence sealed' },
] as const;

type SceneMode = (typeof modes)[number]['id'];

type Oklch = { l: number; c: number; h: number };

function readOklch(styles: CSSStyleDeclaration, token: string, fallback: Oklch): Oklch {
  const raw = styles.getPropertyValue(token).trim();
  const match = raw.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i);
  if (!match) return fallback;
  const lightness = Number(match[1]);
  return {
    l: lightness > 1 ? lightness / 100 : lightness,
    c: Number(match[2]),
    h: Number(match[3]),
  };
}

function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
  const lCube = lRoot ** 3;
  const mCube = mRoot ** 3;
  const sCube = sRoot ** 3;
  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
  return linear.map((channel) => {
    const value = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, value));
  }) as [number, number, number];
}

export function GridInfrastructureScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<SceneMode>('telemetry');
  const [mode, setMode] = useState<SceneMode>('telemetry');
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frame = 0;
    let cleanup = () => {};

    void import('three')
      .then((THREE) => {
        if (disposed) return;

        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const styles = getComputedStyle(host);
        const accent = oklchToSrgb(
          readOklch(styles, '--mk-color-accent', { l: 0.82, c: 0.18, h: 155 }),
        );
        const modeled = oklchToSrgb(
          readOklch(styles, '--mk-color-modeled', { l: 0.72, c: 0.12, h: 225 }),
        );
        const surface = oklchToSrgb(
          readOklch(styles, '--mk-color-paper-3', { l: 0.22, c: 0.018, h: 165 }),
        );
        const rule = oklchToSrgb(
          readOklch(styles, '--mk-color-rule', { l: 0.32, c: 0.018, h: 165 }),
        );

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
        camera.position.set(7.4, 6.1, 8.8);
        camera.lookAt(0.5, 0.25, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(new THREE.Color(...surface), 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.className = 'mk-scene__canvas';
        renderer.domElement.setAttribute('aria-hidden', 'true');
        host.prepend(renderer.domElement);

        const root = new THREE.Group();
        root.rotation.y = -0.34;
        scene.add(root);

        scene.add(new THREE.AmbientLight(new THREE.Color(...surface), 2.3));
        const keyLight = new THREE.DirectionalLight(new THREE.Color(...accent), 5.2);
        keyLight.position.set(-4, 7, 6);
        scene.add(keyLight);
        const rimLight = new THREE.PointLight(new THREE.Color(...modeled), 10, 18);
        rimLight.position.set(5, 3, -3);
        scene.add(rimLight);

        const floorMaterial = new THREE.MeshStandardMaterial({
          color: new THREE.Color(...surface),
          metalness: 0.55,
          roughness: 0.72,
        });
        const floor = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.14, 5.8), floorMaterial);
        floor.position.set(0.25, -0.12, 0);
        root.add(floor);

        const grid = new THREE.GridHelper(
          10,
          24,
          new THREE.Color(...accent),
          new THREE.Color(...rule),
        );
        grid.position.y = -0.035;
        grid.material.opacity = 0.22;
        grid.material.transparent = true;
        root.add(grid);

        const rackMaterial = new THREE.MeshStandardMaterial({
          color: new THREE.Color(...surface).multiplyScalar(0.72),
          metalness: 0.76,
          roughness: 0.34,
        });
        const rackGeometry = new THREE.BoxGeometry(0.58, 1.35, 0.78);
        const rackLightGeometry = new THREE.PlaneGeometry(0.06, 0.78);
        const rackLightMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(...accent) });

        for (let row = 0; row < 2; row += 1) {
          for (let column = 0; column < 5; column += 1) {
            const rack = new THREE.Mesh(rackGeometry, rackMaterial);
            rack.position.set(-2.55 + column * 0.76, 0.62, -0.78 + row * 1.56);
            root.add(rack);

            const indicator = new THREE.Mesh(rackLightGeometry, rackLightMaterial);
            indicator.position.set(rack.position.x - 0.16, rack.position.y, rack.position.z + 0.396);
            root.add(indicator);
          }
        }

        const coolingMaterial = new THREE.MeshStandardMaterial({
          color: new THREE.Color(...modeled),
          metalness: 0.35,
          roughness: 0.45,
          transparent: true,
          opacity: 0.56,
        });
        for (const x of [-2.25, 0.3]) {
          const cooling = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 18), coolingMaterial);
          cooling.rotation.x = Math.PI / 2;
          cooling.position.set(x, 1.48, -0.78);
          root.add(cooling);
        }

        const envelope = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(4.55, 1.95, 3.15)),
          new THREE.LineBasicMaterial({ color: new THREE.Color(...modeled), transparent: true, opacity: 0.66 }),
        );
        envelope.position.set(-1.02, 0.82, 0);
        root.add(envelope);

        const transformer = new THREE.Mesh(
          new THREE.BoxGeometry(1.05, 0.86, 1.18),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(...rule),
            metalness: 0.72,
            roughness: 0.42,
          }),
        );
        transformer.position.set(2.25, 0.38, 0.05);
        root.add(transformer);

        const towerMaterial = new THREE.LineBasicMaterial({ color: new THREE.Color(...rule) });
        const towerPoints = [
          new THREE.Vector3(-0.36, 0, 0),
          new THREE.Vector3(0, 2.1, 0),
          new THREE.Vector3(0.36, 0, 0),
          new THREE.Vector3(-0.24, 0.72, 0),
          new THREE.Vector3(0.24, 0.72, 0),
          new THREE.Vector3(-0.17, 1.35, 0),
          new THREE.Vector3(0.17, 1.35, 0),
          new THREE.Vector3(-0.48, 1.48, 0),
          new THREE.Vector3(0.48, 1.48, 0),
        ];
        const towerIndices = [0, 1, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8];
        const towerGeometry = new THREE.BufferGeometry().setFromPoints(towerPoints);
        towerGeometry.setIndex(towerIndices);
        for (const [x, z, scale] of [
          [3.65, -1.55, 0.78],
          [4.45, 0.05, 0.92],
          [3.65, 1.62, 0.78],
        ] as const) {
          const tower = new THREE.LineSegments(towerGeometry, towerMaterial);
          tower.position.set(x, 0, z);
          tower.scale.setScalar(scale);
          root.add(tower);
        }

        const energyCurve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-2.7, 0.02, 0),
          new THREE.Vector3(-0.6, 0.06, 0),
          new THREE.Vector3(2.2, 0.14, 0),
          new THREE.Vector3(3.2, 0.5, 0),
          new THREE.Vector3(4.35, 1.42, 0),
        ]);
        const energyTube = new THREE.Mesh(
          new THREE.TubeGeometry(energyCurve, 64, 0.025, 8, false),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(...accent), transparent: true, opacity: 0.7 }),
        );
        root.add(energyTube);

        const packetGeometry = new THREE.SphereGeometry(0.07, 12, 12);
        const packetMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(...accent) });
        const packets = Array.from({ length: 7 }, (_, index) => {
          const packet = new THREE.Mesh(packetGeometry, packetMaterial);
          packet.userData.offset = index / 7;
          root.add(packet);
          return packet;
        });

        const nodeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(...accent) });
        for (const x of [-2.55, -1.03, 0.49, 2.25, 4.35]) {
          const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.095, 0), nodeMaterial);
          node.position.set(x, x > 3 ? 1.42 : 0.08, 0);
          root.add(node);
        }

        let pointerX = 0;
        let pointerY = 0;
        const onPointerMove = (event: PointerEvent) => {
          const rect = host.getBoundingClientRect();
          pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
          pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
        };
        const onPointerLeave = () => {
          pointerX = 0;
          pointerY = 0;
        };
        host.addEventListener('pointermove', onPointerMove, { passive: true });
        host.addEventListener('pointerleave', onPointerLeave);

        const resize = () => {
          const width = Math.max(1, host.clientWidth);
          const height = Math.max(1, host.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();

        const positions: Record<SceneMode, [number, number, number]> = {
          telemetry: [7.4, 6.1, 8.8],
          envelope: [6.3, 4.4, 7.1],
          drill: [8.1, 3.8, 5.6],
          passport: [5.8, 5.7, 6.2],
        };

        const render = (time = 0) => {
          const target = positions[modeRef.current];
          camera.position.x += (target[0] + pointerX * 0.34 - camera.position.x) * 0.035;
          camera.position.y += (target[1] - pointerY * 0.22 - camera.position.y) * 0.035;
          camera.position.z += (target[2] - camera.position.z) * 0.035;
          camera.lookAt(0.45, 0.35, 0);
          root.rotation.y += (-0.34 + pointerX * 0.055 - root.rotation.y) * 0.045;
          root.rotation.x += (pointerY * 0.02 - root.rotation.x) * 0.045;

          const seconds = time / 1000;
          packets.forEach((packet) => {
            const progress = (seconds * 0.11 + Number(packet.userData.offset)) % 1;
            packet.position.copy(energyCurve.getPointAt(progress));
          });
          envelope.rotation.y = Math.sin(seconds * 0.32) * 0.018;
          envelope.material.opacity = modeRef.current === 'envelope' ? 0.95 : 0.56;
          renderer.render(scene, camera);
          if (!reduced && !disposed) frame = window.requestAnimationFrame(render);
        };

        setReady(true);
        render();

        cleanup = () => {
          host.removeEventListener('pointermove', onPointerMove);
          host.removeEventListener('pointerleave', onPointerLeave);
          resizeObserver.disconnect();
          window.cancelAnimationFrame(frame);
          scene.traverse((object) => {
            if ('geometry' in object) {
              (object as { geometry?: { dispose?: () => void } }).geometry?.dispose?.();
            }
            if ('material' in object) {
              const material = (object as { material?: { dispose?: () => void } | { dispose?: () => void }[] }).material;
              if (Array.isArray(material)) material.forEach((item) => item.dispose?.());
              else material?.dispose?.();
            }
          });
          renderer.dispose();
          renderer.domElement.remove();
        };
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const active = modes.find((item) => item.id === mode) ?? modes[0];

  return (
    <figure className="mk-scene" aria-labelledby="scene-title" aria-describedby="scene-description">
      <div className="mk-scene__topline">
        <span id="scene-title">GridFlex assurance model</span>
        <span className="mk-live-status"><i aria-hidden="true" /> Demo facility data</span>
      </div>

      <div className="mk-scene__viewport" ref={hostRef} data-ready={ready} data-failed={failed}>
        <div className="mk-scene__fallback" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="mk-scene__readout" aria-live="polite">
          <span>{active.label}</span>
          <strong>{active.detail}</strong>
        </div>

        <div className="mk-scene__meter" aria-hidden="true">
          <span style={{ '--meter': '36%' } as React.CSSProperties} />
          <span style={{ '--meter': '58%' } as React.CSSProperties} />
          <span style={{ '--meter': '76%' } as React.CSSProperties} />
          <span style={{ '--meter': '91%' } as React.CSSProperties} />
        </div>
      </div>

      <div className="mk-scene__modes" role="group" aria-label="Inspect the assurance model">
        {modes.map((item, index) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={mode === item.id}
            onClick={() => setMode(item.id)}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {item.label}
          </button>
        ))}
      </div>

      <figcaption id="scene-description">
        An interactive model of a data centre, its operating envelope, a controlled drill,
        and the evidence path to a GridFlex Proof.
      </figcaption>
    </figure>
  );
}
