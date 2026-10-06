// ── Planetas generados por shader ─────────────────────────────────────────────
//
// Sustituyen a los planetas del kit, que eran bolas pastel genéricas: el elemento que
// más se ve del recorrido (cada sección del portfolio ES un planeta) era el más pobre.
// Aquí cada planeta se calcula en la GPU a partir de ruido, así que pesa 0 KB, es único
// y su estilo lo marca una paleta (ver paletas.js).
//
// Estilo: cartoon a lo No Man's Sky / Astroneer.
//   · Relieve real: la tierra sobresale del océano, el contorno no es una esfera.
//   · Luz por BANDAS (no degradado continuo): es lo que lo hace "de dibujo".
//   · Brillo especular duro sobre el agua, nubes de borde nítido, atmósfera de color.
import * as THREE from 'three';

// Ruido simplex 3D — Ian McEwan / Stefan Gustavson (Ashima Arts), licencia MIT.
const SIMPLEX = /* glsl */`
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
         + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
// Suma de octavas, normalizada a ~[0,1]. OCTAVAS se fija por calidad al compilar.
float fbm(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  // Ganancia 0.45 (no 0.5): las octavas finas pesan menos y salen continentes grandes
  // con poco moteado, que es lo que pide el estilo cartoon.
  for(int i = 0; i < OCTAVAS; i++){ s += a * snoise(p); n += a; p *= 2.03; a *= 0.45; }
  return s / n * 0.5 + 0.5;
}`;

// Luz por bandas. Los bordes entre bandas se suavizan un pelo (0.04) para que no
// "dienteen" con el antialiasing, pero siguen leyéndose como cortes de dibujo.
// Tope en 0.80 a propósito: con 1.0, lo blanco (nieve, nubes) pasaba el umbral del bloom
// (0.95) y se convertía en manchas que se comían el planeta.
const BANDAS = /* glsl */`
float bandas(float ndl){
  return 0.20
    + 0.18 * smoothstep(-0.22, -0.18, ndl)
    + 0.20 * smoothstep( 0.12,  0.16, ndl)
    + 0.22 * smoothstep( 0.55,  0.59, ndl);
}`;

const COLORES = ['oceanoProfundo', 'oceano', 'arena', 'tierra', 'tierraAlta', 'roca', 'nieve'];

function uniformsDePaleta(p) {
  const u = {};
  for (const k of COLORES) u['u_' + k] = { value: new THREE.Color(p[k]) };
  u.u_atmosfera = { value: new THREE.Color(p.atmosfera) };
  u.u_nubes = { value: new THREE.Color(p.nubes ?? 0xffffff) };
  u.uNivelMar = { value: p.nivelMar ?? 0.5 };
  return u;
}

// Superficie: relieve en el vértice, color y luz en el fragmento.
function materialSuperficie({ paleta, semilla, frecuencia, relieve, octavas, sol, niebla }) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uSol: { value: sol },
      uSemilla: { value: new THREE.Vector3(semilla * 17.3, semilla * 9.1, semilla * 4.7) },
      uFrecuencia: { value: frecuencia },
      uRelieve: { value: relieve },
    },
    uniformsDePaleta(paleta),
  ]);
  return new THREE.ShaderMaterial({
    uniforms, fog: niebla, lights: false,
    defines: { OCTAVAS: octavas },
    vertexShader: /* glsl */`
      uniform vec3 uSemilla; uniform float uFrecuencia, uRelieve, uNivelMar;
      varying vec3 vDir; varying vec3 vNormalW; varying vec3 vPosW;
      ${SIMPLEX}
      #include <fog_pars_vertex>
      void main(){
        vDir = normalize(position);
        // Relieve sólo en tierra: el océano queda liso, como agua. Con menos octavas
        // que en el fragmento: el contorno no necesita tanto detalle.
        float h = fbm(vDir * uFrecuencia + uSemilla);
        float tierra = max(h - uNivelMar, 0.0);
        vec3 p = position * (1.0 + uRelieve * tierra);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        vPosW = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSol, uSemilla; uniform float uFrecuencia, uNivelMar;
      uniform vec3 u_oceanoProfundo, u_oceano, u_arena, u_tierra, u_tierraAlta, u_roca, u_nieve, u_atmosfera;
      varying vec3 vDir; varying vec3 vNormalW; varying vec3 vPosW;
      ${SIMPLEX}
      ${BANDAS}
      #include <fog_pars_fragment>
      void main(){
        float h = fbm(vDir * uFrecuencia + uSemilla);
        // Variación lenta de "humedad" para que la tierra no sea un único verde.
        float hum = fbm(vDir * uFrecuencia * 0.6 + uSemilla.zxy + 31.0);
        float m = uNivelMar;
        vec3 col;
        bool agua = h < m;
        // Escalones DUROS entre biomas: el cartoon está en los bordes nítidos.
        if (h < m - 0.10)      col = u_oceanoProfundo;
        else if (h < m)        col = u_oceano;
        else if (h < m + 0.025) col = u_arena;
        else if (h < m + 0.17)  col = mix(u_tierra, u_tierraAlta, step(0.55, hum));
        else if (h < m + 0.26)  col = u_tierraAlta;
        else if (h < m + 0.33)  col = u_roca;
        else                    col = u_nieve;
        // Casquetes polares, con borde irregular.
        float polo = abs(vDir.y) + (hum - 0.5) * 0.25;
        if (polo > 0.92) col = u_nieve;

        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndl = dot(N, uSol);
        vec3 luz = col * bandas(ndl);
        // Brillo especular "de dibujo" sobre el agua: un recorte duro, no un degradado.
        if (agua) {
          float spec = pow(max(dot(reflect(-uSol, N), V), 0.0), 60.0);
          luz += vec3(1.0) * step(0.55, spec) * 0.55;
        }
        // Borde atmosférico dentro del disco: funde la superficie con la capa de fuera.
        float f = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 3.0);
        luz += u_atmosfera * f * (0.35 + 0.65 * smoothstep(-0.3, 0.4, ndl)) * 0.45;
        gl_FragColor = vec4(luz, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// Nubes: capa algo mayor, ruido que se desplaza con el tiempo, borde nítido.
function materialNubes({ semilla, sol, octavas, paleta }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSol: { value: sol }, uTiempo: { value: 0 },
      uSemilla: { value: new THREE.Vector3(semilla * 5.1, semilla * 2.3, semilla * 7.7) },
      uColor: { value: new THREE.Color(paleta.nubes ?? 0xffffff) },
      uCobertura: { value: paleta.nubosidad ?? 0.56 },
    },
    defines: { OCTAVAS: Math.min(octavas, 4) },
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vDir; varying vec3 vNormalW;
      void main(){
        vDir = normalize(position);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSol, uSemilla, uColor; uniform float uTiempo, uCobertura;
      varying vec3 vDir; varying vec3 vNormalW;
      ${SIMPLEX}
      ${BANDAS}
      void main(){
        // Estiradas en horizontal (como bandas de viento) y desplazándose.
        // Frecuencia baja: pocas nubes grandes y alargadas. Más alta salían manchas blancas
        // sueltas que parecían ruido, no nubes.
        vec3 p = vDir * vec3(1.5, 3.6, 1.5) + uSemilla + vec3(uTiempo * 0.035, 0.0, uTiempo * 0.02);
        float n = fbm(p);
        float a = smoothstep(uCobertura, uCobertura + 0.03, n);
        if (a < 0.01) discard;
        float ndl = dot(normalize(vNormalW), uSol);
        gl_FragColor = vec4(uColor * (0.12 + bandas(ndl)), a * 0.9);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Atmósfera: cáscara exterior por la cara de atrás, brillo según el ángulo (fresnel).
function materialAtmosfera({ paleta, sol, intensidad }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(paleta.atmosfera) },
      uSol: { value: sol }, uIntensidad: { value: intensidad },
    },
    transparent: true, depthWrite: false, side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vNW;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        vNW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uSol; uniform float uIntensidad;
      varying vec3 vN; varying vec3 vV; varying vec3 vNW;
      void main(){
        // clamp ANTES de pow: por precisión 1-|dot| puede salir ligeramente negativo, y
        // pow() de un negativo da NaN, que el bloom esparce en bloques negros.
        float borde = clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float f = pow(borde, 1.6) * smoothstep(1.0, 0.82, borde);   // fino y con caída
        float luz = 0.25 + 0.75 * smoothstep(-0.25, 0.45, dot(normalize(vNW), uSol));
        gl_FragColor = vec4(uColor * f * uIntensidad * luz, 1.0);
      }`,
  });
}

// Anillo con bandas concéntricas de colores de la paleta.
function materialAnillo({ paleta, interior, exterior }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Color(paleta.tierra) }, uB: { value: new THREE.Color(paleta.arena) },
      uC: { value: new THREE.Color(paleta.atmosfera) },
      uInt: { value: interior }, uExt: { value: exterior },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uA, uB, uC; uniform float uInt, uExt; varying vec3 vP;
      void main(){
        float r = (length(vP.xy) - uInt) / (uExt - uInt);
        float b = floor(r * 7.0);
        vec3 col = mod(b, 3.0) < 1.0 ? uA : (mod(b, 3.0) < 2.0 ? uB : uC);
        float alfa = (0.55 + 0.35 * fract(sin(b * 12.9) * 43758.5)) * smoothstep(0.0, 0.05, r) * smoothstep(1.0, 0.95, r);
        gl_FragColor = vec4(col, alfa);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ── API ──
// Devuelve { grupo, actualizar(dt), aplicarPaleta(p) }. El grupo mide `radio` de radio.
export function crearPlaneta({
  radio, paleta, semilla = 1, sol,
  frecuencia = 1.1, relieve = 0.08, detalle = 5, octavas = 5,
  nubes = true, anillo = false, niebla = true, intensidadAtmosfera = 1.6,
}) {
  const grupo = new THREE.Group();
  const sup = materialSuperficie({ paleta, semilla, frecuencia, relieve, octavas, sol, niebla });
  // Icosfera: reparto de vértices uniforme (una UVSphere amontona vértices en los polos
  // y el relieve se vería estirado allí).
  const superficie = new THREE.Mesh(new THREE.IcosahedronGeometry(radio, detalle), sup);
  grupo.add(superficie);

  let capaNubes = null;
  if (nubes) {
    capaNubes = new THREE.Mesh(new THREE.IcosahedronGeometry(radio * (1 + relieve * 0.55), Math.max(3, detalle - 1)),
      materialNubes({ semilla, sol, octavas, paleta }));
    grupo.add(capaNubes);
  }
  const atm = new THREE.Mesh(new THREE.IcosahedronGeometry(radio * 1.09, 4),
    materialAtmosfera({ paleta, sol, intensidad: intensidadAtmosfera }));
  grupo.add(atm);

  let aro = null;
  if (anillo) {
    const ri = radio * 1.45, re = radio * 2.2;
    aro = new THREE.Mesh(new THREE.RingGeometry(ri, re, 96, 1), materialAnillo({ paleta, interior: ri, exterior: re }));
    aro.rotation.x = Math.PI / 2.35;
    grupo.add(aro);
  }

  let tiempo = 0;
  return {
    grupo, superficie,
    actualizar(dt) {
      tiempo += dt;
      if (capaNubes) { capaNubes.material.uniforms.uTiempo.value = tiempo; capaNubes.rotation.y += dt * 0.012; }
    },
    // Cambia los colores en caliente (sin recompilar): sirve para comparar paletas.
    aplicarPaleta(p) {
      const u = sup.uniforms;
      for (const k of COLORES) u['u_' + k].value.set(p[k]);
      u.u_atmosfera.value.set(p.atmosfera);
      u.uNivelMar.value = p.nivelMar ?? 0.5;
      atm.material.uniforms.uColor.value.set(p.atmosfera);
      if (capaNubes) {
        capaNubes.material.uniforms.uColor.value.set(p.nubes ?? 0xffffff);
        capaNubes.material.uniforms.uCobertura.value = p.nubosidad ?? 0.56;
      }
      if (aro) {
        aro.material.uniforms.uA.value.set(p.tierra);
        aro.material.uniforms.uB.value.set(p.arena);
        aro.material.uniforms.uC.value.set(p.atmosfera);
      }
    },
  };
}
