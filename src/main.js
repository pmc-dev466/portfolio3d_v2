import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Los modelos van comprimidos con meshopt (scripts/optimize-models.mjs): 1.9 MB → 541 KB.
// El decodificador es WebAssembly, por eso la CSP lleva 'wasm-unsafe-eval'.
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
// Las fuentes se importan desde aquí y no con un <link> en el HTML: así Vite las
// empaqueta con hash en el nombre y se pueden cachear un año sin riesgo.
import './fonts/fonts.css';
// Fuente píxel de la pantalla de título. Sólo el subconjunto latino (ñ, tildes): unos KB.
import '@fontsource/press-start-2p/latin-400.css';
import { createRouteInput } from './input.js';
import { createDirector } from './director.js';
import { guionCombate, guionAgujero } from './guiones.js';
import { crearPlaneta } from './planetas.js';
import { PALETAS, PALETA_ACTIVA, BIOMA_SECCION, AJUSTE_KIT, ajustarAtlas, ajustarColor, CIELOS } from './paletas.js';

// Mapa nombre → URL final de cada modelo. Vite copia cada .glb al build con un hash
// de su contenido en el nombre (spaceship-3f9a1c.glb). Si un modelo cambia, cambia su
// URL, así que la caché de un año nunca puede servir una versión vieja. Con rutas
// fijas, cualquier retoque a un modelo dejaba a los visitantes recurrentes con el
// antiguo hasta un año.
const MODELOS = Object.fromEntries(
  Object.entries(import.meta.glob('./models/*.glb', { query:'?url', import:'default', eager:true }))
    .map(([ruta, url]) => [ruta.slice(9, -4), url])          // "./models/x.glb" → "x"
);
// El postprocesado ya no se importa aquí arriba: se carga bajo demanda sólo si el
// preset activa bloom (ver más abajo). Así, con bloom apagado, esos 6 ficheros ni
// se descargan.

// ══ CALIDAD ════════════════════════════════════════════════════════════════════
// Único sitio donde subir o bajar el coste. Se autodetecta un nivel y se puede forzar
// con ?q=alta|media|baja para comparar sin tocar código.
//
// bloom:false por defecto, y es una decisión medida, no estética a ojo:
//  1. UnrealBloomPass es de los pases más caros que hay (varios blur a resolución
//     completa por frame).
//  2. Más importante: EffectComposer renderiza a un render target SIN multisampling
//     (comprobado, su código no menciona `samples`), así que en cuanto se usa, el
//     `antialias:true` del renderer deja de tener efecto. Quitar bloom devuelve el
//     MSAA real, o sea que los bordes MEJORAN al quitarlo.
//  3. La web de referencia no usa postprocesado en absoluto.
const esMovil = matchMedia('(max-width: 820px), (pointer: coarse)').matches;
const nivelPedido = new URLSearchParams(location.search).get('q');
const NIVEL = ['alta','media','baja'].includes(nivelPedido) ? nivelPedido : (esMovil ? 'baja' : 'alta');
const PRESETS = {
  alta:  { maxDpr:1.8, sombras:true,  mapaSombra:2048, bloom:true,  octavas:5, rocas:[60,18], polvo:900, fugaces:20, trafico:8 },
  media: { maxDpr:1.5, sombras:true,  mapaSombra:1024, bloom:true,  octavas:4, rocas:[40,12], polvo:550, fugaces:14, trafico:5 },
  baja:  { maxDpr:1.0, sombras:false, mapaSombra:512,  bloom:false, octavas:3, rocas:[24, 8], polvo:320, fugaces:8,  trafico:3 },
};
const Q = PRESETS[NIVEL];

// Escenario construido en código (hangares, plataformas, puertas, tráfico) en la clave
// de la paleta activa. `tono` aplica el mismo ajuste que al atlas del kit. `metal`
// limita la metalicidad: a 0.8, con este entorno, cualquier color se veía gris oscuro, y
// en la estética cartoon el color tiene que leerse.
const AJUSTE_ESCENA = AJUSTE_KIT[PALETA_ACTIVA];
const tono  = hex => ajustarColor(hex, AJUSTE_ESCENA);
const metal = m => AJUSTE_ESCENA ? Math.min(m, 0.35) : m;
// Variante PROFUNDA para las estructuras gigantes (la fachada del hangar de llegada mide
// 236 × 126 unidades): con el tono normal quedaban gris claro y, ocupando media pantalla,
// se leían como niebla plana. Más oscuras se recortan contra el cielo como estructura.
const tonoProfundo = hex => AJUSTE_ESCENA ? ajustarColor(hex, { ...AJUSTE_ESCENA, luz: [0.12, 0.42] }) : hex;
const tonoCss = hex => '#' + tono(hex).toString(16).padStart(6, '0');
console.info(`[recorrido] calidad: ${NIVEL}`, Q);

// ── Utilidades de interpolación ───────────────────────────────────────────────
// Van aquí arriba y no junto al bucle porque construirHangar() las usa al construir
// la escena, mucho antes. Declaradas con const más abajo caerían en la zona muerta
// temporal y reventaría al cargar.
//
// smoothK: suavizado independiente del framerate. Un `* 0.08` por frame hace que a
// 144Hz la cámara responda más del doble de rápido que a 60Hz — la misma web se
// sentiría distinta según el equipo.
const smoothK = (rate, dt)=> 1 - Math.pow(1 - rate, dt*60);
const smoothstep01 = x=>{ x = x<0?0:(x>1?1:x); return x*x*(3-2*x); };


// ── Carga de modelos ──
// Antes iban incrustados en base64 dentro del HTML para que funcionara con doble
// clic. Al desplegar en GitHub Pages hay servidor HTTP de verdad, así que se sirven
// como binarios: 139KB menos (base64 ocupa un 33% más) y el navegador los cachea por
// separado. A cambio, ya NO se puede abrir con doble clic: file:// bloquea el fetch.
function assetError(msg){
  const box = document.getElementById('assetErrors');
  box.classList.add('show');
  box.insertAdjacentHTML('beforeend', msg + '<br>');
}
if(location.protocol === 'file:'){
  assetError('⚠ Ábrelo con un servidor (<b>npm run dev</b>), no con doble clic:<br>file:// bloquea la carga de los modelos.');
}

// El LoadingManager permite enseñar progreso real antes de dejar despegar.
const loadManager = new THREE.LoadingManager();
const gltfLoader = new GLTFLoader(loadManager).setMeshoptDecoder(MeshoptDecoder);
const _modelCache = {};
const _modelPending = {};
// El atlas de colores del kit se reescribe UNA vez con el ajuste de la paleta activa y
// se comparte entre todos los modelos (cada .glb trae su copia de la misma imagen).
// Se hace sobre el modelo en caché, antes de clonarlo: los clones comparten material,
// así que lo heredan también los materiales que el código clona después.
let atlasKit = null;
function recolorearKit(raiz){
  const ajuste = AJUSTE_KIT[PALETA_ACTIVA];
  if(!ajuste) return;
  raiz.traverse(o=>{
    if(!o.isMesh) return;
    for(const m of [].concat(o.material)){
      if(!m.map || m.name !== 'Atlas' || !m.map.image) continue;
      if(!atlasKit){
        atlasKit = new THREE.CanvasTexture(ajustarAtlas(m.map.image, ajuste));
        for(const k of ['flipY','colorSpace','magFilter','minFilter','wrapS','wrapT','generateMipmaps']) atlasKit[k] = m.map[k];
      }
      m.map = atlasKit;
      m.needsUpdate = true;
    }
  });
}
function getModel(name, cb){
  if(_modelCache[name]){ cb(_modelCache[name].clone(true)); return; }
  // Si ya hay una carga en vuelo para este modelo, engancharse a ella. Sin esto, dos
  // llamadas en el mismo tick (el planeta se usa en dos sitios) pedían el GLB dos
  // veces y se quedaban dos copias en memoria.
  if(_modelPending[name]){ _modelPending[name].push(cb); return; }
  _modelPending[name] = [cb];
  const flush = result=>{
    const queue = _modelPending[name]; delete _modelPending[name];
    queue.forEach(fn=> fn(result ? result.clone(true) : null));
  };
  const url = MODELOS[name];
  if(!url){
    // Nombre mal escrito en el código: fallo de desarrollo, se dice alto y claro.
    console.error('Modelo desconocido:', name);
    assetError(`⚠ Modelo desconocido <b>${name}</b>`);
    flush(null); return;
  }
  gltfLoader.load(url, gltf=>{
    recolorearKit(gltf.scene);
    _modelCache[name] = gltf.scene;
    flush(gltf.scene);
  }, undefined, err=>{
    console.warn('No se pudo cargar', name, err);
    assetError(`⚠ No se pudo cargar <b>${name}.glb</b>`);
    flush(null);
  });
}
// Normaliza un modelo a un tamaño objetivo y lo devuelve YA CENTRADO dentro de un
// Group envoltorio. Devolver el envoltorio (y no el propio mesh) es importante: el
// centrado se guarda en mesh.position, así que si el llamante hacía
// `normalizeModel(m,4); m.position.copy(destino)` estaba machacando el centrado y
// el modelo quedaba descolocado respecto a su punto. Moviendo el Group, no pasa.
function normalizeModel(mesh, targetSize){
  mesh.updateWorldMatrix(true,true);
  const dim = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  const maxDim = Math.max(dim.x,dim.y,dim.z) || 1;
  mesh.scale.multiplyScalar(targetSize/maxDim);
  mesh.updateWorldMatrix(true,true);
  mesh.position.sub(new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()));
  const wrap = new THREE.Group();
  wrap.add(mesh);
  return wrap;
}

// Extrae geometría+material listos para InstancedMesh.
// Estos .glb vienen de FBX2glTF y traen un nodo hijo con scale=100, con los vértices
// en el rango ~0.05. Coger `child.geometry` a pelo descarta ese x100 y los objetos
// salen ~100 veces más pequeños de lo pedido (los asteroides eran motas invisibles).
// Aquí horneamos matrixWorld en la geometría y la normalizamos a 1 unidad, de modo
// que la escala por instancia pase a significar unidades de mundo reales.
// Los modelos llegan CUANTIZADOS: posiciones, normales y UV como enteros de 8-16 bits
// normalizados, con la escala real guardada en la transformación del nodo. Para
// pintarlos tal cual da igual, pero bakedGeometry hornea esa transformación en la
// propia geometría, y escribir valores fuera de [-1, 1] en un atributo normalizado
// los RECORTA: todas las rocas y planetas quedarían aplastados en un cubo de lado 2.
// Por eso, antes de hornear, cada atributo entero se pasa a float32.
function aFlotante(geo){
  for(const [nombre, a] of Object.entries(geo.attributes)){
    if(a.array instanceof Float32Array) continue;
    const n = a.itemSize, out = new Float32Array(a.count * n);
    const get = [a.getX, a.getY, a.getZ, a.getW];        // getX… ya desnormalizan
    for(let i=0;i<a.count;i++) for(let k=0;k<n;k++) out[i*n+k] = get[k].call(a, i);
    geo.setAttribute(nombre, new THREE.BufferAttribute(out, n));
  }
  return geo;
}
function bakedGeometry(root){
  root.updateWorldMatrix(true,true);
  let geo = null, mat = null;
  root.traverse(c=>{
    if(c.isMesh && !geo){ geo = aFlotante(c.geometry.clone()); geo.applyMatrix4(c.matrixWorld); mat = c.material; }
  });
  if(!geo) return null;
  geo.computeBoundingBox();
  const center = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-center.x, -center.y, -center.z);
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  const k = 1/(Math.max(size.x,size.y,size.z) || 1);
  geo.scale(k,k,k);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, mat };
}

// Marca un objeto (y sus hijos) como emisor y receptor de sombra. Se centraliza para
// que apagar sombras en el preset "baja" no deje flags sueltos por ahí.
function activarSombras(obj){
  if(!Q.sombras) return;
  obj.traverse(c=>{ if(c.isMesh || c.isInstancedMesh){ c.castShadow = true; c.receiveShadow = true; } });
}

// ── Contenido real ──
const WAYPOINTS = [
  { tag:'01 · Experiencia', title:'Experiencia', accentHex:0xff6b4a, t:0.06,
    stats:[{n:'3+',l:'años desarrollando'},{n:'2025',l:'paso a análisis técnico'},{n:'Scrum',l:'y Kanban'}],
    items:[
      {t:'Analista de Software', s:'iConsulting365 · 06/2025–Actual', d:'Análisis de OTs, requisitos, estimaciones, code reviews y liderazgo técnico.'},
      {t:'Desarrollador de Software', s:'iConsulting365 · 10/2022–06/2025', d:'Backend Java 21 + Spring Boot para sistemas de la Junta de Andalucía.'}
    ]},
  { tag:'02 · Skills', title:'Stack técnico', accentHex:0x3fd8c2, t:0.22,
    tags:['Java 21','Spring Boot','Spring Security','Microservicios','Arq. Hexagonal','Oracle SQL','MongoDB','Docker','Azure Pipelines','JUnit'] },
  { tag:'03 · Proyectos', title:'Proyectos', accentHex:0x56b8ff, t:0.40,
    items:[
      {t:'Sistemas Junta de Andalucía', s:'Java 21 · Spring Boot · Microservicios', d:'APIs REST consumidas por frontends Angular, comunicación sync/async.'},
      {t:'Análisis y especificación técnica', s:'Requisitos · Estimaciones · Casos de uso', d:'Evaluación de órdenes de trabajo: viabilidad, impacto en los sistemas existentes y esfuerzo, hasta dejar la especificación que el equipo ejecuta.'}
    ]},
  // Contacto ya no es un planeta-hito: ahora es el final del recorrido, cuando la nave
  // aterriza. Tener la llamada a la acción de pasada, a mitad de vuelo, la desperdiciaba.
  { tag:'04 · Formación', title:'Formación', accentHex:0xcfe0e8, t:0.86,
    items:[
      {t:'Grado en Ing. Informática', s:'Universidad de Sevilla · 2016–2022', d:'Mención en Ingeniería del Software.'},
      {t:'Inglés B2', s:'Nivel intermedio-alto', d:'Comunicación técnica en inglés.'}
    ]},
];

// ── Zonas: cada una define rango de t, color de niebla, densidad, etiqueta ──
// Los límites están medidos sobre la parametrización por longitud de arco de la curva,
// no puestos a ojo: 'Entrada atmosférica' cubre ahora la subida y el desplome reales
// (t≈0.58–0.78) y la estación cae en el tramo llano posterior, no dentro del picado.
const ZONES = [
  { name:'Espacio profundo', from:0.00, to:0.16, fog:0x030c14, density:0.010 },
  { name:'Campo de asteroides', from:0.16, to:0.34, fog:0x0a0f16, density:0.014 },
  { name:'Nebulosa', from:0.34, to:0.58, fog:0x1a1030, density:0.016 },
  { name:'Entrada atmosférica', from:0.58, to:0.78, fog:0x2a3a55, density:0.030 },
  { name:'Estación derelicta', from:0.78, to:0.93, fog:0x0a1420, density:0.015 },
  { name:'Llegada', from:0.93, to:1.00, fog:0x030c14, density:0.010 },
];
// Cielo de la paleta activa (si la paleta trae el suyo).
if(CIELOS[PALETA_ACTIVA]) ZONES.forEach((z, i)=> z.fog = CIELOS[PALETA_ACTIVA].zonas[i] ?? z.fog);
function zoneAt(p){ return ZONES.find(z=>p>=z.from && p<=z.to) || ZONES[ZONES.length-1]; }

// ── Scene ──
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(ZONES[0].fog, 0.010);
// El cielo ES el color de la niebla: se comparte el mismo objeto Color, así que cuando
// el bucle funde la niebla de una zona a otra, el fondo la sigue sin código extra.
// Antes el fondo era negro fijo mientras la niebla se teñía de morado o azul. Todo lo
// lejano quedaba "lleno" de niebla y se recortaba sobre el negro como una silueta plana:
// la fachada del hangar de llegada se veía desde media ruta como un muro de 236 × 126
// unidades con el borde en escalera. Ahora lo lejano se funde con el cielo.
scene.background = scene.fog.color;
const camera = new THREE.PerspectiveCamera(56, innerWidth/innerHeight, 0.1, 2000);
const BASE_FOV = 56;
const director = createDirector({ camera, baseFov: BASE_FOV });
// ── Comprobación de WebGL ANTES de construir nada ──
// Sin esto, en un navegador sin WebGL (GPU en lista negra, aceleración desactivada,
// máquina virtual corporativa) el constructor de WebGLRenderer lanza y la página se
// queda en negro sin decir por qué. En un portfolio eso es la peor primera impresión
// posible: parece roto, no incompatible.
function hayWebGL(){
  try{
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
              (c.getContext('webgl2') || c.getContext('webgl')));
  }catch(e){ return false; }
}
if(!hayWebGL()){
  const aviso = document.createElement('div');
  aviso.id = 'sinWebgl';
  // textContent en cada trozo: nada de este texto viene de fuera, pero es gratis
  // construirlo sin HTML y así no queda un innerHTML más que auditar.
  const h = document.createElement('h1'); h.textContent = 'Este recorrido necesita WebGL';
  const p = document.createElement('p');
  p.textContent = 'Tu navegador no puede dibujar gráficos 3D. Prueba con Chrome, Edge, Firefox o Safari actualizados, o activa la aceleración por hardware en los ajustes.';
  const p2 = document.createElement('p');
  p2.className = 'sw-sub';
  p2.textContent = 'Mientras tanto, el contenido del portfolio está más abajo.';
  aviso.append(h, p, p2);
  document.body.prepend(aviso);
  document.documentElement.style.overflow = 'auto';
  const ov = document.getElementById('startOverlay'); if(ov) ov.style.display = 'none';
  // Cortar la evaluación del módulo aquí: todo lo que viene detrás depende del renderer.
  throw new Error('[recorrido] WebGL no disponible — se ha mostrado el aviso de compatibilidad');
}

const renderer = new THREE.WebGLRenderer({antialias:true, powerPreference:'high-performance', stencil:false});
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.maxDpr));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 1.25 compensaba la falta de bloom. Con bloom esa compensación sobra y lavaba los
// colores claros del kit (el planeta del picado salía casi pastel).
renderer.toneMappingExposure = Q.bloom ? 1.1 : 1.25;

// ── Sombras ──
// Una cámara de sombra que cubriera las 320 unidades de ruta daría una resolución
// inservible, así que se usa una caja pequeña que VIAJA con la nave (se reposiciona
// en el bucle). Donde más se van a notar es en la plataforma y, más adelante, en el
// hangar: en espacio abierto no hay superficies donde proyectar.
if(Q.sombras){
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
document.getElementById('stage').appendChild(renderer.domElement);

// Entorno PMREM: sin esto, cualquier material metálico (el valor por defecto en
// glTF si no se especifica metalness) se ve negro pase lo que pase con las luces.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose(); // la textura ya está generada; el generador sólo ocupa VRAM

// Iluminación de más contraste. Antes había mucho relleno (ambiente 1.1 + hemisférica
// 1.3 frente a un sol de 1.6), lo que aplana todo: en el espacio no hay atmósfera que
// rebote luz, así que la cara iluminada es dura y la sombreada casi negra. Al quitar
// el bloom, ese contraste es lo que sostiene la imagen.
scene.add(new THREE.AmbientLight(0x1a2e38, 0.45));
scene.add(new THREE.HemisphereLight(0x8fc4e8, 0x08101a, 0.55)); // no se atenúa con la distancia
const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
const SUN_DIR = new THREE.Vector3(0.42, 0.72, 0.36).normalize(); // dirección fija de la "estrella"
sun.position.copy(SUN_DIR).multiplyScalar(60);
scene.add(sun);
scene.add(sun.target);
// (Se quitó el PointLight fijo en (0,15,10): con rango 400 sobre una ruta de 320
// unidades apenas aportaba y se pagaba en cada material. La nave lleva sus luces.)

if(Q.sombras){
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.mapaSombra, Q.mapaSombra);
  const s = 26;
  sun.shadow.camera.left = -s; sun.shadow.camera.right  =  s;
  sun.shadow.camera.top  =  s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;  sun.shadow.camera.far    = 160;
  sun.shadow.bias = -0.0007;      // evita el acné de sombra en superficies planas
  sun.shadow.normalBias = 0.03;   // evita el "peter-panning" en geometría fina
}

// Resolución relativa del render (1 = normal). En la portada la escena se dibuja a unas
// 190 filas y se escala sin suavizar: píxel gordo de verdad, con la escena real detrás.
let factorRes = 1;
const FILAS_TITULO = 190;
// Con la ventana a 0 de alto (pestaña oculta al cargar) la división daba infinito y el
// factor se quedaba en 1: la portada salía nítida. Se acota por los dos lados.
const factorTitulo = ()=> innerHeight > 0
  ? Math.min(1, FILAS_TITULO / (innerHeight * Math.min(devicePixelRatio, Q.maxDpr))) : 0.25;
function aplicarResolucion(f){
  factorRes = f;
  const pr = Math.min(devicePixelRatio, Q.maxDpr) * f;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  if(composer){ composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight); }
  renderer.domElement.classList.toggle('pixel', f < 1);
}
// "Enfoque" al terminar la intro: la resolución sube A SALTOS, no de forma continua, como
// el mosaico de las transiciones de 16 bits. Cada salto cuesta un redimensionado, así
// que son pocos y sólo ocurren una vez.
const enfoque = { activo:false, t:0, desde:1, pasos:6, dur:1.1, ultimo:-1 };
function iniciarEnfoque(){ Object.assign(enfoque, { activo:true, t:0, desde:factorRes, ultimo:-1 }); }
function actualizarEnfoque(dtReal){
  if(!enfoque.activo) return;
  enfoque.t += dtReal;
  const paso = Math.min(enfoque.pasos, Math.floor(enfoque.t / enfoque.dur * enfoque.pasos) + 1);
  if(paso !== enfoque.ultimo){
    enfoque.ultimo = paso;
    // Progresión geométrica: cada salto duplica más o menos la resolución.
    aplicarResolucion(paso >= enfoque.pasos ? 1 : enfoque.desde * Math.pow(1/enfoque.desde, paso/enfoque.pasos));
  }
  if(paso >= enfoque.pasos) enfoque.activo = false;
}

const BLOOM = { fuerza: 0.5, radio: 0.4, umbral: 0.95 };
// ── Postprocesado: bloom ──
// Se quitó en su día porque EffectComposer dibujaba en un buffer SIN multimuestreo y el
// antialiasing del lienzo dejaba de tener efecto: los bordes empeoraban. La solución es
// darle un buffer propio con samples:4 (MSAA real, como el del lienzo) y en HalfFloat,
// para que el bloom trabaje con el brillo REAL de la escena —motores, disparos y
// explosiones pasan de 1.0— antes de que el tone mapping lo comprima.
// Import dinámico: en "baja" (móviles) estos ficheros ni se descargan.
let composer = null, bloomPass = null;

if(Q.bloom){
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
  ]);
  const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  // Umbral alto a propósito: sólo brilla lo que de verdad emite luz. Con el umbral
  // bajo de antes (0.15) florecía todo lo iluminado por el sol y la imagen se lavaba.
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), BLOOM.fuerza, BLOOM.radio, BLOOM.umbral);
  composer.addPass(bloomPass);
  // OutputPass aplica el tone mapping y la conversión a sRGB al final. Con composer,
  // el renderer dibuja en lineal y sin esto la imagen saldría oscura y sin contraste.
  composer.addPass(new OutputPass());
}
function dibujar(){
  if(composer) composer.render();
  else renderer.render(scene, camera);
}

// ── Textura de brillo radial, reutilizada por polvo, motores y estelas ──
function makeGlowTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(0.25,'rgba(255,255,255,.55)');
  g.addColorStop(1,'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0,0,64,64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLOW_TEX = makeGlowTexture();

// ── Textura de estrella ──
// Sin `map`, PointsMaterial dibuja el punto como un CUADRADO sólido: por eso el cielo
// se veía a bloques. Este disco tiene núcleo duro y un halo corto, que a tamaños de
// 1-2px sigue leyéndose como estrella y no como mancha.
function makeStarTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(16,16,0,16,16,16);
  g.addColorStop(0,    'rgba(255,255,255,1)');
  g.addColorStop(0.30, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1,    'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0,0,32,32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const STAR_TEX = makeStarTexture();

// ── Textura de onda expansiva: un anillo, no un disco ──
// Un sprite de brillo radial que crece se lee como "una luz que se apaga". Un ANILLO
// que crece se lee como una explosión, porque el hueco central deja ver los escombros
// saliendo por dentro. Es la diferencia entre un fogonazo y un reventón.
function makeShockTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0,    'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.80, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.92, 'rgba(255,255,255,0.28)');
  g.addColorStop(1,    'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0,0,128,128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const SHOCK_TEX = makeShockTexture();

// ── Starfield ──
// El campo se centra en el punto medio de la ruta (z≈-100), no en el origen: la ruta
// llega hasta z=-260 y con el centro en 0 la última mitad del viaje se quedaba sin
// estrellas por delante. El campo lejano además sigue a la cámara en el bucle
// (cielo "infinito"); el cercano se queda en mundo para que haya paralaje real.
const ROUTE_MID = new THREE.Vector3(0, 3, -100);
function makeStars(count, spread, size, color, center){
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count*3);
  for(let i=0;i<count;i++){
    pos[i*3]   = (Math.random()-0.5)*spread + (center?center.x:0);
    pos[i*3+1] = (Math.random()-0.5)*spread + (center?center.y:0);
    pos[i*3+2] = (Math.random()-0.5)*spread + (center?center.z:0);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.computeBoundingSphere();
  // fog:false porque las estrellas están en el infinito: la niebla las convertiría en
  // puntos del mismo color que el cielo, es decir, invisibles. Su atenuación en zonas
  // densas se hace a mano en el bucle (ver ESTRELLAS_OPACIDAD).
  return new THREE.Points(g, new THREE.PointsMaterial({
    color, size, map:STAR_TEX, sizeAttenuation:true,
    transparent:true, opacity:0.9, depthWrite:false, fog:false,
  }));
}
const starsFar  = makeStars(2600, 1400, 1.1, 0xbfe4ff, null);       // se reposiciona sobre la cámara
const starsNear = makeStars(650,  900, 2.0, 0xff6b4a, ROUTE_MID);
starsFar.frustumCulled = false;
scene.add(starsFar, starsNear);

// ── RUTA AUTORADA A MANO (larga, varias zonas) ──────────────────────────────
const routePoints = [
  new THREE.Vector3(0,   3,   60),
  new THREE.Vector3(15,  7,   30),
  new THREE.Vector3(-8,  2,   4),
  new THREE.Vector3(12,  9,  -30),   // zona asteroides
  new THREE.Vector3(-14, 4,  -62),
  new THREE.Vector3(8,   10, -95),   // zona nebulosa
  new THREE.Vector3(-10, 6, -125),
  new THREE.Vector3(2,   14, -150),  // entra en atmósfera (sube)
  new THREE.Vector3(4,  -6, -170),   // CAÍDA — se hunde bruscamente
  new THREE.Vector3(-6, -2, -195),   // estación derelicta
  new THREE.Vector3(10,  3, -225),
  new THREE.Vector3(0,   0, -260),   // llegada final
];
const curve = new THREE.CatmullRomCurve3(routePoints, false, 'catmullrom', 0.35);

// ── Beat dramático: rango de t donde ocurre la "caída" ──
// El centro está medido, no estimado. Muestreando la tangente de la curva, el descenso
// más pronunciado (51°, tangente.y = -0.78) cae en t = 0.710. El valor anterior, 0.585,
// apuntaba a un tramo donde la ruta va nivelada e incluso SUBE (tangente.y = +0.36 hacia
// t=0.62): la pantalla temblaba y destellaba en llano y luego el desplome real ocurría
// sin ningún efecto.
const DIVE_CENTER = 0.710, DIVE_HALF = 0.05;
function diveIntensity(p){
  const d = Math.abs(p - DIVE_CENTER) / DIVE_HALF;
  return d>=1 ? 0 : (1 - d)*(1-d)*(3-2*(1-d)); // smoothstep triangular
}

// Línea guía tenue
// A opacidad 0.12 esta línea cruzaba el encuadre y se leía como un artefacto de
// render, no como una guía. Bajada a 0.045 y sin escribir en el z-buffer.
const routeGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(320));
scene.add(new THREE.Line(routeGeo, new THREE.LineBasicMaterial({color:0x3fd8c2, transparent:true, opacity:0.045, depthWrite:false})));

// ── Planetas-hito: cada sección del portfolio ES un planeta ──
// Antes eran octaedros de 0.9 unidades pegados a la ruta. El concepto del recorrido es
// pasar junto a planetas, así que se usa el modelo real, a escala de planeta y
// alternando de lado para que la ruta serpentee entre ellos.
const wpPlanetGroup = new THREE.Group();
scene.add(wpPlanetGroup);
const waypointPlanets = [];
const WORLD_UP_C = new THREE.Vector3(0,1,0);

// Todos los planetas generados, para animar sus nubes en el bucle y poder cambiarles
// la paleta en caliente (herramienta de desarrollo).
const planetasProc = [];

function placeWaypointPlanet(wp, i){
  const center  = curve.getPointAt(wp.t);
  const tangent = curve.getTangentAt(wp.t).normalize();
  const side    = new THREE.Vector3().crossVectors(tangent, WORLD_UP_C).normalize();
  const dir     = (i % 2 === 0) ? 1 : -1;
  const radius  = 6.5 + (i % 3) * 1.9;
  // El 11 base subió a 16 por lo mismo que el planeta grande: la holgura hay que
  // medirla contra la cámara, y el hito de t=0.40 (radio 10.3) se quedaba en 6.1.
  const pos = center.clone()
    .addScaledVector(side, (radius + 16 + (i % 3) * 3) * dir)
    .addScaledVector(WORLD_UP_C, dir > 0 ? -4.5 : 5.5);

  const bioma = BIOMA_SECCION[i % BIOMA_SECCION.length];
  const planeta = crearPlaneta({
    radio: radius, paleta: PALETAS[PALETA_ACTIVA][bioma], semilla: 1.7 + i * 2.3, sol: SUN_DIR,
    frecuencia: 1.15, relieve: 0.09, detalle: Q.octavas >= 5 ? 5 : 4, octavas: Q.octavas,
  });
  planeta.bioma = bioma;
  planetasProc.push(planeta);
  const mesh = planeta.grupo;
  mesh.position.copy(pos);
  wpPlanetGroup.add(mesh);

  // Halo atmosférico: sprite aditivo (siempre encara a cámara y no escribe en el
  // z-buffer, así que no recorta lo que tiene detrás como hacía la esfera anterior).
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW_TEX, color: wp.accentHex, transparent: true,
    opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.setScalar(radius * 4.4);
  halo.position.copy(pos);
  wpPlanetGroup.add(halo);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius*1.5, radius*2.15, 72),
    new THREE.MeshBasicMaterial({color:wp.accentHex, transparent:true, opacity:0.2, side:THREE.DoubleSide, depthWrite:false})
  );
  ring.position.copy(pos);
  ring.rotation.set(Math.PI/2.4 + i*0.28, i*0.7, 0);
  wpPlanetGroup.add(ring);

  wp._markerPos = pos;
  // `idx` guarda a qué sección pertenece. Hace falta porque ahora cada planeta carga
  // su propio modelo y el array se llena en el orden en que TERMINAN las descargas,
  // no en el de las secciones: usar la posición del array para saber cuál está activo
  // encendía el halo del planeta equivocado.
  waypointPlanets.push({ idx: i, mesh, halo, ring, spin: 0.04 + i*0.012, baseHalo: 0.45 });
}

// UN PLANETA DISTINTO POR SECCIÓN. Antes las cuatro usaban el mismo modelo y por eso
// se veían genéricas y repetidas: estábamos cargando sólo la variante base del kit,
// que trae once planetas diferentes. Cada sección carga el suyo y se tiñe con su color.
WAYPOINTS.forEach((wp, i)=> placeWaypointPlanet(wp, i));

// ── ZONA: campo de asteroides — modelos reales vía InstancedMesh ──
// Una sola llamada de carga + una sola llamada de dibujo por tipo de roca,
// en vez de 36 clones/materiales independientes.
const asteroidGroup = new THREE.Group();
scene.add(asteroidGroup);
function buildAsteroidField(rockMesh, count, sizeRange){
  const baked = bakedGeometry(rockMesh);   // hornea el scale=100 del nodo FBX2glTF
  if(!baked) return null;
  const geoR = baked.geo.boundingSphere.radius;   // radio de la geometría normalizada
  const inst = new THREE.InstancedMesh(baked.geo, baked.mat, count);
  // Un InstancedMesh calcula el frustum con la bounding sphere de UNA roca en el
  // origen, no con la nube de instancias: sin esto el campo entero desaparecía en
  // cuanto el origen salía de cámara.
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  activarSombras(inst);
  const dummy = new THREE.Object3D();
  const zone = ZONES[1];
  const rocks = [];
  const _tan = new THREE.Vector3(), _side = new THREE.Vector3(), _vert = new THREE.Vector3();
  for(let i=0;i<count;i++){
    const tt = THREE.MathUtils.lerp(zone.from, zone.to, Math.random());
    const base = curve.getPointAt(tt);
    const s = sizeRange[0] + Math.random()*(sizeRange[1]-sizeRange[0]);
    const worldR = s * geoR;                 // radio real del asteroide, en unidades
    // Dos arreglos aquí:
    // 1) El desplazamiento se hace en el plano PERPENDICULAR a la ruta usando el marco
    //    local de la curva. Antes se usaban ejes de mundo, así que en los tramos donde
    //    la ruta corre en X un offset en X caía justo encima del camino.
    // 2) El radio mínimo incluye el tamaño del propio asteroide y el vaivén lateral de
    //    la cámara (±2.2). Con el 7 fijo anterior, el 33% de las rocas grandes acababa
    //    con holgura NEGATIVA: la cámara pasaba por dentro de la roca.
    curve.getTangentAt(tt, _tan).normalize();
    _side.crossVectors(_tan, WORLD_UP_C).normalize();
    _vert.crossVectors(_side, _tan).normalize();
    const ang = Math.random()*Math.PI*2;
    const rad = worldR + 11 + Math.random()*22;
    dummy.position.copy(base)
      .addScaledVector(_side, Math.cos(ang)*rad)
      .addScaledVector(_vert, Math.sin(ang)*rad);
    dummy.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    rocks.push({
      pos: dummy.position.clone(), scale: s,
      spin: (Math.random()-0.5)*0.35,
      phase: Math.random()*Math.PI*2,
      tilt: (Math.random()-0.5)*0.25,
      rad, along: tt,             // rad: distancia lateral a la ruta; along: t de la curva
      objetivo:false, disparado:false, muerto:false,
    });
  }
  // Objetivos de disparo: las rocas con MENOR rad son las más cercanas al eje de vuelo,
  // así que son las que se leen como "en el camino". Se eligen sólo esas — no todas —
  // para que cada disparo sea un momento con peso y no una ametralladora constante.
  const orden = rocks.map((r,i)=>i).sort((a,b)=> rocks[a].rad - rocks[b].rad);
  const nObjetivos = Math.max(1, Math.round(count * 0.14));
  for(let k=0;k<Math.min(nObjetivos, orden.length);k++) rocks[orden[k]].objetivo = true;

  inst.userData.rocks = rocks;
  asteroidGroup.add(inst);
  return inst;
}

// SIETE siluetas de roca, no dos. El campo se veía monótono porque estábamos cargando
// sólo la variante base del kit (`Rock` y `Rock Large`) teniendo cinco más sin usar:
// un bloque, un canto rodado, una aguja fina, un peñasco alto y una losa plana. Cada
// variante es su propio InstancedMesh —una llamada de dibujo por silueta, siete en
// total, que no es nada— y el número de rocas total no cambia: se reparte.
const ROCAS_PEQUENAS = ['rock', 'rock_a', 'rock_b', 'rock_c'];
const ROCAS_GRANDES  = ['rock_large', 'rock_large_a', 'rock_large_b'];
ROCAS_PEQUENAS.forEach((nombre, i)=>{
  const n = Math.round(Q.rocas[0] / ROCAS_PEQUENAS.length);
  // Cada silueta cubre un tramo de tamaños distinto para que además de forma varíe la
  // escala, y no parezcan la misma roca clonada a distintos zooms.
  const lo = 1.0 + i*0.35, hi = 2.4 + i*0.5;
  getModel(nombre, m=>{ if(m) buildAsteroidField(m, n, [lo, hi]); });
});
ROCAS_GRANDES.forEach((nombre, i)=>{
  const n = Math.round(Q.rocas[1] / ROCAS_GRANDES.length);
  const lo = 3.0 + i*0.8, hi = 6.0 + i*1.1;
  getModel(nombre, m=>{ if(m) buildAsteroidField(m, n, [lo, hi]); });
});

// ── RESTOS DE BATALLA ─────────────────────────────────────────────────────────
// Chatarra flotando justo ANTES del combate: cuando llegas a la persecución ya sabes
// que aquí ha pasado algo.
//
// La primera versión reutilizaba la geometría de `spaceship` deformada en cada eje,
// con la idea de que se leyera como cascos partidos. No funciona: por mucho que se
// estire, una nave sigue teniendo silueta de nave, así que lo que se veía eran naves
// enteras paradas en mitad del espacio — parecía un fallo de modelado, no un campo de
// restos. Lo que sí se lee como chatarra son PIEZAS DE ESTRUCTURA sueltas: una viga,
// un módulo de casco reventado, un panel arrancado. Son las mismas piezas de la
// estación derelicta, así que no cuesta ni un byte de descarga extra.
const restosGrupo = new THREE.Group();
scene.add(restosGrupo);
const restosCampos = [];                   // { inst, dat[] } — uno por tipo de pieza
// 0.235 ± 0.035, no 0.255 ± 0.05: con las cámaras laterales de la cinemática, la
// chatarra que llegaba hasta 0.305 se metía delante de los cazas y tapaba los planos.
const RESTOS_T = 0.235;                    // antes del combate (0.30), sin solaparse

// Reparto por tipo: la proporción importa. Muchas vigas y pocos módulos hace que
// parezca una estructura desmontada; al revés, un desguace. Mitad y mitad se lee como
// una nave grande reventada, que es lo que se busca.
const RESTOS_PIEZAS = [
  { modelo:'metal_support',         peso:0.42, esc:[1.6, 5.5] },   // vigas retorcidas
  { modelo:'connector',             peso:0.34, esc:[1.4, 3.6] },   // módulos de casco
  { modelo:'solar_panel_structure', peso:0.24, esc:[1.8, 4.2] },   // paneles arrancados
];

{
  const tanR  = curve.getTangentAt(RESTOS_T).normalize();
  const sideR = new THREE.Vector3().crossVectors(tanR, WORLD_UP_C).normalize();
  const vertR = new THREE.Vector3().crossVectors(sideR, tanR).normalize();
  const TOTAL = Math.round(Q.rocas[1] * 1.6);

  RESTOS_PIEZAS.forEach(pieza=>{
    const N = Math.max(2, Math.round(TOTAL * pieza.peso));
    getModel(pieza.modelo, m=>{
      if(!m) return;
      const baked = bakedGeometry(m);
      if(!baked) return;
      // Metal quemado: se parte del material de la pieza y se oscurece y ensucia. Una
      // pieza de estación limpia flotando en el vacío no dice "aquí hubo un combate".
      const mat = baked.mat.clone();
      // Con la paleta caramelo el atlas ya es claro: multiplicarlo por el gris oscuro de
      // antes (0x6a7078) dejaba la chatarra casi negra, desentonando con todo lo demás.
      mat.color = new THREE.Color(AJUSTE_KIT[PALETA_ACTIVA] ? 0xa8a4b8 : 0x6a7078);
      mat.metalness = 0.72; mat.roughness = 0.62;
      const inst = new THREE.InstancedMesh(baked.geo, mat, N);
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      activarSombras(inst);

      const dat = [];
      const d = new THREE.Object3D();
      for(let i=0;i<N;i++){
        // Repartidos a lo LARGO de la ruta (±0.05 en t ≈ 40 unidades) y no apiñados en
        // un punto. Y con radio corto: a 13-39 del eje quedaban a casi 90° justo al
        // pasar y no se veía ni uno. Lo que importa es que se vean ACERCÁNDOSE de
        // frente, no que estén al lado.
        const tt = RESTOS_T + (Math.random()-0.5)*0.07;
        const base = curve.getPointAt(THREE.MathUtils.clamp(tt, 0.01, 0.99));
        const ang = Math.random()*Math.PI*2;
        const rad = 11 + Math.random()*18;
        const pos = base.clone()
          .addScaledVector(sideR, Math.cos(ang)*rad)
          .addScaledVector(vertR, Math.sin(ang)*rad);
        const s = pieza.esc[0] + Math.random()*(pieza.esc[1]-pieza.esc[0]);
        dat.push({
          pos, esc:s,
          // Giro propio en los tres ejes y a ritmos distintos: la chatarra a la deriva
          // cabecea, no está clavada. Es lo que la separa de "un objeto colocado ahí".
          giro: new THREE.Vector3((Math.random()-0.5)*0.5, (Math.random()-0.5)*0.5, (Math.random()-0.5)*0.5),
          fase: new THREE.Vector3(Math.random()*6.28, Math.random()*6.28, Math.random()*6.28),
        });
        d.position.copy(pos);
        d.rotation.set(dat[i].fase.x, dat[i].fase.y, dat[i].fase.z);
        d.scale.setScalar(s);
        d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
      }
      restosCampos.push({ inst, dat });
      restosGrupo.add(inst);
    });
  });
}

// ── ZONA: nebulosa (sprites de gradiente radial, técnica canvas) ──
function makeNebulaTexture(hex){
  const c=document.createElement('canvas'); c.width=256; c.height=256;
  const cx=c.getContext('2d');
  const g=cx.createRadialGradient(128,128,0,128,128,128);
  const col=new THREE.Color(hex);
  const r=Math.round(col.r*255),gr=Math.round(col.g*255),b=Math.round(col.b*255);
  g.addColorStop(0,`rgba(${r},${gr},${b},0.5)`);
  g.addColorStop(0.4,`rgba(${r},${gr},${b},0.18)`);
  g.addColorStop(1,`rgba(${r},${gr},${b},0)`);
  cx.fillStyle=g; cx.fillRect(0,0,256,256);
  return new THREE.CanvasTexture(c);
}
// El Group se coloca EN el centro de la nebulosa y los sprites cuelgan con posiciones
// relativas. Antes los sprites llevaban coordenadas de mundo (z≈-110) con el Group en
// el origen, así que el `rotation.y` del bucle no los hacía girar sobre sí mismos: los
// paseaba en un arco de radio 110 y la nebulosa se iba flotando de sitio.
const nebulaGroup = new THREE.Group();
// 0.32 y no 0.42: con el bloom la escena se dibuja en coma flotante y los 16 sprites,
// que se solapan, se SUMAN sin techo. A 0.42 la nebulosa salía magenta saturado.
const NEBULA_OPACIDAD = Q.bloom ? 0.32 : 0.42;
{
  const zone = ZONES[2];
  const cols = CIELOS[PALETA_ACTIVA]?.nebulosa ?? [0x9a4cff,0x3a5cff,0x2ee6c0,0xff5c8a];
  const texCache = cols.map(c=>makeNebulaTexture(c)); // 4 texturas, no una por sprite
  const center = curve.getPointAt((zone.from+zone.to)/2);
  nebulaGroup.position.copy(center);
  for(let i=0;i<16;i++){
    const tt = THREE.MathUtils.lerp(zone.from, zone.to, Math.random());
    const base = curve.getPointAt(tt).sub(center); // relativo al centro del grupo
    const offset = new THREE.Vector3((Math.random()-0.5)*46,(Math.random()-0.5)*24,(Math.random()-0.5)*46);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map:texCache[i%texCache.length], transparent:true, opacity:NEBULA_OPACIDAD, blending:THREE.AdditiveBlending, depthWrite:false }));
    spr.position.copy(base).add(offset);
    const sz = 30+Math.random()*34;
    spr.scale.set(sz,sz,1);
    nebulaGroup.add(spr);
  }
}
scene.add(nebulaGroup);

// ── AGUJERO NEGRO ──────────────────────────────────────────────────────────────
// Sin lente gravitacional: eso exige un pase de postprocesado a pantalla completa, y
// quitamos el postprocesado precisamente para recuperar el MSAA. Lo que sí lo hace
// reconocible es el disco de acreción (bandas espirales calientes) + el horizonte
// negro + materia cayendo en espiral, y eso sale a 3 draw calls.
//
// Los materiales llevan `fog:false` A PROPÓSITO: está a 130 unidades y la niebla de
// la zona (densidad 0.016, visibilidad ~60) lo borraría por completo. Un objeto
// colosal y lejano debe verse a través de la bruma, igual que las estrellas.
const AGUJERO_T = 0.50;
const AGUJERO_R = 26;                       // radio del horizonte de sucesos
let agujeroDisco = null, agujeroPolvo = null, agujeroPolvoDat = [], agujeroFotones = null;
const agujeroGrupo = new THREE.Group();
{
  // Colocación medida simulando la CÁMARA REAL (posición + orientación) y proyectando.
  // El primer intento lo puse "al lado de la ruta" y quedaba a 90° del eje de vista:
  // NDC de 6.5, o sea nunca entraba en pantalla. Lo que funciona es anclarlo DELANTE
  // de donde mira la cámara: 210 unidades al frente desde t=0.46, 70 de lado y 35 de
  // alto. Así se ve durante el 32% del recorrido, pasa como mucho a 196 unidades
  // (holgura de 118 al borde del disco) y ocupa el 78% del alto de pantalla.
  const anclaT = 0.46;
  const p0 = curve.getPointAt(anclaT);
  const f0 = curve.getTangentAt(anclaT).normalize();
  const s0 = new THREE.Vector3().crossVectors(f0, WORLD_UP_C).normalize();
  agujeroGrupo.position.copy(p0)
    .addScaledVector(f0, 210).addScaledVector(s0, 70).addScaledVector(WORLD_UP_C, 35);
  // El disco vive en el plano XY local, así que su normal es +Z: lookAt lo pone de
  // cara al observador y el rotateX lo inclina para que se lea como un disco y no
  // como un círculo plano.
  agujeroGrupo.lookAt(curve.getPointAt(0.56));
  agujeroGrupo.rotateX(0.62);
  // La orientación se calcula, no se elige a ojo: con la rotación fija anterior el
  // disco quedaba a 78° de la cámara, o sea CASI DE CANTO, y por eso apenas se veía
  // (cambiaba un 0.19% de los píxeles pese a ocupar 40° de campo). Se apunta hacia
  // el tramo desde el que se ve y luego se inclina para verlo en escorzo.
  scene.add(agujeroGrupo);

  // Horizonte: negro absoluto. Sin luces ni entorno, para que recorte de verdad.
  const horizonte = new THREE.Mesh(
    new THREE.SphereGeometry(AGUJERO_R, 48, 32),
    new THREE.MeshBasicMaterial({ color:0x000000, fog:false })
  );
  agujeroGrupo.add(horizonte);

  // Anillo de fotones: borde brillante justo fuera del horizonte.
  agujeroFotones = new THREE.Mesh(
    new THREE.TorusGeometry(AGUJERO_R*1.06, 0.7, 8, 96),
    new THREE.MeshBasicMaterial({ color:0xffd9a0, transparent:true, opacity:0.85,
                                  blending:THREE.AdditiveBlending, depthWrite:false, fog:false })
  );
  agujeroGrupo.add(agujeroFotones);

  // Disco de acreción: bandas espirales que giran, más calientes hacia dentro.
  agujeroDisco = new THREE.Mesh(
    new THREE.RingGeometry(AGUJERO_R*1.25, AGUJERO_R*3.0, 160, 1),
    new THREE.ShaderMaterial({
      uniforms: { uTime:{ value:0 }, uOpacidad:{ value:0 } },
      vertexShader: `
        varying vec3 vPos;
        void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform float uOpacidad; varying vec3 vPos;
        void main(){
          float r = length(vPos.xy);
          float a = atan(vPos.y, vPos.x);
          float t = smoothstep(32.5, 78.0, r);              // 0 dentro (caliente) .. 1 fuera
          // Bandas en espiral: el término -log(r) es lo que las curva como un remolino
          // en vez de dejarlas como radios rectos.
          float bandas = sin(a*2.0 - log(max(r,1.0))*7.0 + uTime*1.1)*0.5 + 0.5;
          bandas = pow(bandas, 2.2);
          // Rotación diferencial: dentro va más rápido, como en un disco real.
          float fino = sin(a*7.0 - log(max(r,1.0))*15.0 + uTime*2.4)*0.5 + 0.5;
          float brillo = mix(1.0, 0.12, t) * (0.45 + 0.55*bandas) * (0.75 + 0.25*fino);
          vec3 dentro = vec3(1.0, 0.93, 0.78);
          vec3 fuera  = vec3(1.0, 0.42, 0.16);
          vec3 col = mix(dentro, fuera, t);
          float alfa = brillo * (1.0 - smoothstep(0.82, 1.0, t));
          gl_FragColor = vec4(col*brillo, alfa) * uOpacidad;
        }`,
      transparent:true, blending:THREE.AdditiveBlending,
      depthWrite:false, side:THREE.DoubleSide, fog:false,
    })
  );
  agujeroGrupo.add(agujeroDisco);

  // Materia cayendo: puntos en espiral hacia el horizonte, se reinician al llegar.
  const NP = 700;
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(NP*3);
  g.setAttribute('position', new THREE.BufferAttribute(p,3).setUsage(THREE.DynamicDrawUsage));
  agujeroPolvo = new THREE.Points(g, new THREE.PointsMaterial({
    color:0xffc98a, size:0.9, map:STAR_TEX, sizeAttenuation:true,
    transparent:true, opacity:0.9, depthWrite:false,
    blending:THREE.AdditiveBlending, fog:false,
  }));
  agujeroPolvo.frustumCulled = false;
  agujeroGrupo.add(agujeroPolvo);
  for(let i=0;i<NP;i++){
    agujeroPolvoDat.push({
      r: AGUJERO_R*1.3 + Math.random()*AGUJERO_R*1.9,
      a: Math.random()*Math.PI*2,
      y: (Math.random()-0.5)*3.5,
      vel: 0.22 + Math.random()*0.5,
    });
  }
}

// ── ZONA: estación derelicta — piezas modulares reales ──
const stationGroup = new THREE.Group();
scene.add(stationGroup);
{
  const zone = ZONES[4];
  const midT = (zone.from+zone.to)/2;
  // La estación estaba centrada SOBRE la ruta: con los módulos a ±9 en X, building_l
  // quedaba a 1.8 unidades del eje de vuelo y la nave lo atravesaba. Se aparta de
  // costado con la normal de la curva, igual que los planetas-hito. Medido: la peor
  // holgura pasa de 1.8 a 10.9 unidades.
  const tanS  = curve.getTangentAt(midT).normalize();
  const sideS = new THREE.Vector3().crossVectors(tanS, new THREE.Vector3(0,1,0)).normalize();
  const base  = curve.getPointAt(midT).addScaledVector(sideS, 20).addScaledVector(new THREE.Vector3(0,1,0), -5);
  const modules = [
    { model:'connector', size:4.5, offset:new THREE.Vector3(-9,0,0) },
    { model:'metal_support', size:4.0, offset:new THREE.Vector3(-4,0.5,1) },
    { model:'building_l', size:6.5, offset:new THREE.Vector3(2,-0.5,-1) },
    { model:'solar_panel_structure', size:5.5, offset:new THREE.Vector3(8,1,0) },
  ];
  modules.forEach(mod=>{
    getModel(mod.model, m=>{
      if(!m) return;
      // normalizeModel devuelve un envoltorio ya centrado: hay que mover ESE, no el
      // mesh, o se pierde el centrado y la pieza queda desplazada de su hueco.
      const wrap = normalizeModel(m, mod.size);
      activarSombras(wrap);
      wrap.position.copy(base).add(mod.offset);
      wrap.rotation.y = Math.random()*Math.PI*2;
      // Deriva lenta: una estación abandonada no está clavada en el sitio.
      wrap.userData.drift = { phase:Math.random()*Math.PI*2, amp:0.25+Math.random()*0.35, y:wrap.position.y };
      stationGroup.add(wrap);
    });
  });
  // luces parpadeantes (siguen siendo procedurales — son solo puntos de luz)
  const blinkGeo = new THREE.SphereGeometry(0.25,8,8); // compartida por las 4
  for(let i=0;i<6;i++){
    // MeshBasicMaterial ignora `opacity` si no es transparente: el parpadeo del bucle
    // no se veía en absoluto. Con transparent:true ya funciona.
    const lightSph = new THREE.Mesh(blinkGeo, new THREE.MeshBasicMaterial({color:0xffcf8a, transparent:true, opacity:1, depthWrite:false}));
    lightSph.position.copy(base).add(new THREE.Vector3((Math.random()-0.5)*20, 1.5+Math.random()*3, (Math.random()-0.5)*8));
    lightSph.userData.blink = Math.random()*Math.PI*2;
    stationGroup.add(lightSph);
  }
}

// ── ASTRONAUTA A LA DERIVA ────────────────────────────────────────────────────
// Flotando junto a la estación abandonada, girando muy despacio. Es un detalle
// narrativo que cuesta un modelo y cambia por completo la lectura del sitio: pasa de
// "chatarra" a "aquí pasó algo". Va apartado del eje de vuelo como todo lo demás,
// pero lo bastante cerca para que se distinga la figura al pasar.
let astronauta = null;
getModel('astronaut', m=>{
  if(!m) return;
  astronauta = normalizeModel(m, 2.4);
  activarSombras(astronauta);
  // El traje es casi negro y ahí fuera no hay nada que lo ilumine de relleno, así que
  // la figura se perdía contra el fondo: se veía un borrón oscuro, no un astronauta.
  // La solución no es aclarar el color (eso lava la textura) sino usar su PROPIO mapa
  // como emisivo a intensidad baja: levanta la figura entera respetando su dibujo.
  astronauta.traverse(c=>{
    if(!c.isMesh || !c.material) return;
    const mat = c.material.clone();
    if(mat.map) mat.emissiveMap = mat.map;
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = 0.32;
    c.material = mat;
  });
  const zA = ZONES[4];
  const tA = (zA.from + zA.to)/2 - 0.035;          // algo antes que la estación
  const baseA = curve.getPointAt(tA);
  const tanA  = curve.getTangentAt(tA).normalize();
  const sideA = new THREE.Vector3().crossVectors(tanA, WORLD_UP_C).normalize();
  const vertA = new THREE.Vector3().crossVectors(sideA, tanA).normalize();
  astronauta.position.copy(baseA)
    .addScaledVector(sideA, 13)
    .addScaledVector(vertA, 3.5);
  // Giro lento y descontrolado en los tres ejes: no lleva propulsión, va a la deriva.
  astronauta.userData.giro = new THREE.Vector3(0.09, 0.13, 0.07);
  scene.add(astronauta);
});

// ── ZONA: planeta grande en la entrada atmosférica (modelo real) ──
// Este es el planeta hacia el que se hace el picado, así que llena media pantalla: es
// el modelo que más se mira de todo el recorrido. Estaba usando `planet.glb`, que
// renderizado de cerca resulta NO ser un planeta sino una bola beige con pinchos
// cónicos de 1320 triángulos. A 46 unidades eso se lee exactamente como "esto no tiene
// modelo". El kit traía un planeta de verdad, con continentes y 10 688 triángulos, sin
// usar: son 276 KB bien gastados porque es el plano estrella del viaje.
let bigPlanet = null;
{
  const zone = ZONES[3];
  const midT = (zone.from+zone.to)/2;
  // Radio 48, el mismo que tenía el modelo normalizado a 100 de diámetro: la posición
  // de abajo se calculó con ese tamaño (holgura ≥ 36 contra toda la ruta de la cámara).
  // Sin niebla: está en la zona más densa y a 50-80 unidades quedaría lavado (medido:
  // el 96 % de su color era niebla). Más detalle de malla porque llena la pantalla.
  const planeta = crearPlaneta({
    radio: 48, paleta: PALETAS[PALETA_ACTIVA].hogar, semilla: 4.2, sol: SUN_DIR,
    frecuencia: 1.0, relieve: 0.035, detalle: Q.octavas >= 5 ? 6 : 5, octavas: Q.octavas,
    niebla: false, intensidadAtmosfera: 1.9,
  });
  planeta.bioma = 'hogar';
  planetasProc.push(planeta);
  bigPlanet = planeta.grupo;
  bigPlanet.position.copy(curve.getPointAt(midT)).add(new THREE.Vector3(-17.2, -99.4, -47.6));
  scene.add(bigPlanet);
}

// ── NAVE PROTAGONISTA (chase-cam) — modelo real ──
// shipRoot es el objeto que el bucle de animación mueve/orienta cada frame;
// el modelo real se cuelga dentro en cuanto termina de cargar (evita reescribir
// la lógica de cámara si la carga tarda un poco).
const shipRoot = new THREE.Group();
scene.add(shipRoot);
let shipOrientNode = null;      // envoltorio al que se aplica la corrección de ejes
let engineFlare = null, engineLight = null;

getModel('spaceship', m=>{
  if(!m) return;
  // 2.1, no 2.6: comentaste que se veía grande. Ojo, esto también encoge la estela y
  // el fogonazo, que se posicionan en unidades locales de la nave.
  const wrap = normalizeModel(m, 2.1);
  m.traverse(c=>{ if(c.isMesh) c.castShadow = true; });
  shipRoot.add(wrap);
  shipOrientNode = wrap;
  applyShipOrientation();

  const shipKeyLight = new THREE.PointLight(0xffffff, 1.8, 12);
  shipKeyLight.position.set(0,2,-2);
  shipRoot.add(shipKeyLight);

  // Motor: la luz y la llama van en +Z de shipRoot porque el "delante" de shipRoot
  // es -Z (es lo que produce Matrix4.lookAt), así que +Z es la cola.
  engineLight = new THREE.PointLight(0x5fe0ff, 1.4, 6);
  engineLight.position.set(0,0,1.3);
  shipRoot.add(engineLight);

  // Núcleo del motor: pequeño a propósito. Antes era un sprite que llegaba a escala
  // 3.2 sobre una nave de 2.6 unidades, así que envolvía la nave entera en una bola
  // de luz. La sensación de empuje la da ahora la estela, no el tamaño del destello.
  engineFlare = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW_TEX, color: 0xbdf1ff, transparent: true,
    opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  engineFlare.position.set(0, 0.05, 1.2);
  engineFlare.scale.set(0.6, 0.6, 1);
  shipRoot.add(engineFlare);
});
const ship = shipRoot; // el resto del código ya referencia "ship" para posición/rotación

// ── Corrección de orientación del modelo ──
// Medido sobre los vértices de spaceship.glb (no es una conjetura): el casco es más
// largo en Z y, rebanándolo, el extremo -Z es ancho (0.099 de envergadura: alas y
// motores) mientras que el extremo +Z se afila hasta 0.0038 — o sea, el morro apunta
// a +Z. Matrix4.lookAt orienta -Z hacia el objetivo, así que hay que girar 180° en Y
// para llevar el morro a -Z. El valor anterior era 180° en Z, que deja el morro
// apuntando igual hacia atrás y además pone la nave boca abajo: volaba de espaldas.
const SHIP_ORIENT = { x:0, y:Math.PI, z:0 };
function applyShipOrientation(){
  if(!shipOrientNode) return;
  shipOrientNode.rotation.set(SHIP_ORIENT.x, SHIP_ORIENT.y, SHIP_ORIENT.z);
  document.getElementById('shipOrientReadout').textContent =
    `X:${Math.round(SHIP_ORIENT.x*180/Math.PI)}° Y:${Math.round(SHIP_ORIENT.y*180/Math.PI)}° Z:${Math.round(SHIP_ORIENT.z*180/Math.PI)}°`;
}
document.querySelectorAll('#shipOrientPanel button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const axis = btn.dataset.axis, dir = parseFloat(btn.dataset.dir);
    SHIP_ORIENT[axis] += (Math.PI/2) * dir;
    applyShipOrientation();
  });
});
// El panel de calibración ya no hace falta en uso normal: se abre con ?debug o con "D".
if(location.search.includes('debug')) document.body.classList.add('debug');
addEventListener('keydown', e=>{ if(e.key==='d'||e.key==='D') document.body.classList.toggle('debug'); });

// ── ESTELA DEL MOTOR ──────────────────────────────────────────────────────────
// Se traza el rastro real de la tobera con un búfer circular de posiciones.
// Se descartó la cinta (ribbon) orientada a cámara: en una chase-cam la estela sale
// justo hacia la cámara, así que el producto vectorial con la dirección de vista es
// degenerado casi siempre y la cinta se vería de canto. Un penacho de puntos aditivos
// siempre encara a cámara y se lee bien desde detrás, que es la vista habitual.
// 84 muestras cada 1/120 s: el mismo largo que las 42 a 1/60 de antes, con el doble de
// densidad. Al estrechar la estela, desde las cámaras laterales de las cinemáticas se
// veían los huecos entre puntos (una ristra de cuentas en vez de un penacho).
const TRAIL_LEN = 84, TRAIL_STEP = 1/120;
const trailPts = Array.from({length:TRAIL_LEN}, ()=> new THREE.Vector3());
let trailHead = 0, trailAccum = 0, trailReady = false;

const trailGeo = new THREE.BufferGeometry();
const trailPosArr = new Float32Array(TRAIL_LEN*3);
const trailSize   = new Float32Array(TRAIL_LEN);
const trailFade   = new Float32Array(TRAIL_LEN);
const trailSizeBase = new Float32Array(TRAIL_LEN);   // tamaño de diseño; trailSize se adapta
const _trailPrev = new THREE.Vector3();
for(let i=0;i<TRAIL_LEN;i++){
  const f = i/(TRAIL_LEN-1);   // 0 = tobera, 1 = cola
  // Tamaños en UNIDADES DE MUNDO (la nave mide 2.6): estrecho en la tobera, se abre
  // como un penacho y se disipa. El paso a píxeles lo hace uScale en el shader.
  // Más estrecha y corta que antes (era 0.16 + 0.5·sin y fade^1.6). Desde la cámara de
  // persecución la COLA queda más cerca de la lente que la tobera, así que los puntos
  // anchos del final se veían enormes; con el bloom eso era una bola que tapaba la nave.
  // Comparadas tres variantes en el mismo fotograma: ésta deja ver las toberas.
  trailSize[i] = 0.10 + 0.26*Math.sin(f*Math.PI*0.85);
  trailFade[i] = Math.pow(1-f, 2.6);
  trailSizeBase[i] = trailSize[i];
}
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPosArr,3).setUsage(THREE.DynamicDrawUsage));
trailGeo.setAttribute('aSize', new THREE.BufferAttribute(trailSize,1).setUsage(THREE.DynamicDrawUsage));
trailGeo.setAttribute('aFade', new THREE.BufferAttribute(trailFade,1));

// PointsMaterial no admite tamaño por punto, así que hace falta un shader mínimo
// para que la estela se estreche hacia la cola.
const trailMat = new THREE.ShaderMaterial({
  uniforms: {
    uTex:    { value: GLOW_TEX },
    uColor:  { value: new THREE.Color(0x6fd9ff) },
    uThrust: { value: 0 },
    uMaxPx:  { value: 48 },
    // Factor de proyección: convierte un tamaño en unidades de mundo a píxeles.
    // Es alto/(2·tan(fov/2)); se recalcula por frame porque el FOV cambia en la caída.
    uScale:  { value: 600 },
  },
  vertexShader: `
    attribute float aSize;
    attribute float aFade;
    uniform float uThrust;
    uniform float uScale;
    varying float vFade;
    uniform float uMaxPx;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float d = -mv.z;
      // Los puntos casi pegados a la lente se desvanecen: con la cámara detrás de la nave
      // la cola de la estela queda ENCIMA de la cámara y tapaba el plano con un borrón.
      vFade = aFade * uThrust * smoothstep(1.2, 4.5, d);
      // Tope en píxeles por la misma razón: un punto a 1 unidad de la cámara ocupaba
      // media pantalla. El tope es relativo al alto del lienzo (ver uMaxPx en el bucle).
      gl_PointSize = min(aSize * uThrust * uScale / max(d, 0.001), uMaxPx);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D uTex;
    uniform vec3 uColor;
    varying float vFade;
    void main(){
      gl_FragColor = vec4(uColor, 1.0) * texture2D(uTex, gl_PointCoord) * vFade;
    }`,
  // Mezcla por MÁXIMO, no por suma. Desde la cámara de persecución los 42 puntos se
  // apilan sobre la tobera. En el lienzo de 8 bits la suma se quedaba en 1.0 y no se
  // notaba, pero con el bloom la escena se dibuja en coma flotante y la suma llegaba a
  // 6.8 (medido): el bloom la convertía en una bola blanca que tapaba media nave. Con
  // máximo cada píxel se queda con el punto más brillante: mismo aspecto que antes, sin
  // apilamiento. Sin multiplicador: con ×1.6 el núcleo se quemaba a blanco; así roza el
  // umbral del bloom y el resplandor conserva el cian.
  transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
});
const trailMesh = new THREE.Points(trailGeo, trailMat);
trailMesh.frustumCulled = false;
scene.add(trailMesh);

// ── HUMO DE IGNICIÓN ──────────────────────────────────────────────────────────
// Partículas billboard, no volumétrico (eso no es viable en tiempo real en web).
// Nacen en la tobera, bajan hasta el suelo del hangar y ahí se abren en horizontal:
// es lo que hace que se lea como humo rebotando contra la plataforma y no como una
// nube flotando. Alfa normal, no aditivo: el humo aditivo parece fuego.
const SMOKE_MAX = Q.rocas[0] >= 40 ? 220 : 90;   // escala con el preset de calidad
const humoGeo = new THREE.BufferGeometry();
const humoPos  = new Float32Array(SMOKE_MAX*3);
const humoSize = new Float32Array(SMOKE_MAX);
const humoFade = new Float32Array(SMOKE_MAX);
humoGeo.setAttribute('position', new THREE.BufferAttribute(humoPos,3).setUsage(THREE.DynamicDrawUsage));
humoGeo.setAttribute('aSize',    new THREE.BufferAttribute(humoSize,1).setUsage(THREE.DynamicDrawUsage));
humoGeo.setAttribute('aFade',    new THREE.BufferAttribute(humoFade,1).setUsage(THREE.DynamicDrawUsage));

function makeSmokeTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,   'rgba(255,255,255,0.55)');
  g.addColorStop(0.45,'rgba(255,255,255,0.22)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0,0,64,64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const humoMat = new THREE.ShaderMaterial({
  uniforms: { uTex:{ value: makeSmokeTexture() }, uColor:{ value: new THREE.Color(0xc8d6dd) }, uScale:{ value: 600 } },
  vertexShader: `
    attribute float aSize; attribute float aFade;
    uniform float uScale; varying float vFade;
    void main(){
      vFade = aFade;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D uTex; uniform vec3 uColor; varying float vFade;
    void main(){
      vec4 t = texture2D(uTex, gl_PointCoord);
      gl_FragColor = vec4(uColor, t.a * vFade);
    }`,
  transparent: true, depthWrite: false,
});
const humo = new THREE.Points(humoGeo, humoMat);
humo.frustumCulled = false;
scene.add(humo);

const humoP = Array.from({length:SMOKE_MAX}, ()=>({
  pos:new THREE.Vector3(), vel:new THREE.Vector3(), vida:0, maxVida:1, tam:1, viva:false,
}));
let humoCursor = 0, humoAcum = 0, humoHabia = false;

function emitirHumo(origen, cantidad){
  for(let k=0;k<cantidad;k++){
    const h = humoP[humoCursor]; humoCursor = (humoCursor + 1) % SMOKE_MAX;
    // Sin `new Vector3` aquí: se emiten ~90 partículas por segundo y sería basura
    // constante para el recolector, justo lo que se quitó del bucle principal.
    h.pos.set(origen.x + (Math.random()-0.5)*1.4, origen.y, origen.z + (Math.random()-0.5)*1.4);
    // Sale hacia abajo con dispersión; al tocar suelo se convierte en horizontal.
    h.vel.set((Math.random()-0.5)*3.5, -6 - Math.random()*5, (Math.random()-0.5)*3.5);
    h.vida = 0; h.maxVida = 1.6 + Math.random()*1.8;
    h.tam = 0.9 + Math.random()*1.1;
    h.viva = true;
  }
}

// ══ VIDA EN EL MUNDO ═══════════════════════════════════════════════════════════
// Todo lo de abajo está pensado para costar 1 draw call por sistema: geometría única
// actualizada en CPU (son pocos vértices) en vez de decenas de objetos sueltos.

// ── Estrellas fugaces ──
// Un solo LineSegments con 2 vértices por estela. El desvanecido va en color de
// vértice (cabeza brillante → cola apagada) porque un material sólo tiene una opacity.
const SHOOTER_COUNT = Q.fugaces;
const shooterGeo = new THREE.BufferGeometry();
const shooterPos = new Float32Array(SHOOTER_COUNT*6);
const shooterCol = new Float32Array(SHOOTER_COUNT*6);
shooterGeo.setAttribute('position', new THREE.BufferAttribute(shooterPos,3).setUsage(THREE.DynamicDrawUsage));
shooterGeo.setAttribute('color',    new THREE.BufferAttribute(shooterCol,3).setUsage(THREE.DynamicDrawUsage));
const shooterMesh = new THREE.LineSegments(shooterGeo, new THREE.LineBasicMaterial({
  vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false,
}));
shooterMesh.frustumCulled = false;
scene.add(shooterMesh);

const SHOOTER_TINTS = [0xffffff, 0xbfe4ff, 0xff6b4a, 0x3fd8c2, 0xffcf8a];
const shooters = [];
for(let i=0;i<SHOOTER_COUNT;i++){
  shooters.push({
    pos:new THREE.Vector3(), vel:new THREE.Vector3(), col:new THREE.Color(),
    life:0, maxLife:1, len:6, delay:Math.random()*9, active:false,
  });
}
function spawnShooter(s, camPos){
  // Nace en una esfera alrededor de la cámara y cruza el encuadre.
  const r = 70 + Math.random()*110;
  const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
  s.pos.set(Math.sin(ph)*Math.cos(th), Math.cos(ph)*0.55, Math.sin(ph)*Math.sin(th))
       .multiplyScalar(r).add(camPos);
  // Dirección tangencial: si apuntase al centro pasarían todas por encima de la nave.
  s.vel.set(Math.random()-0.5, (Math.random()-0.5)*0.45, Math.random()-0.5)
       .normalize().multiplyScalar(60 + Math.random()*110);
  s.col.setHex(SHOOTER_TINTS[(Math.random()*SHOOTER_TINTS.length)|0]);
  s.life = 0;
  s.maxLife = 0.8 + Math.random()*1.2;
  s.len = 4 + Math.random()*11;
  s.active = true;
}

// ── Disparos automáticos ──────────────────────────────────────────────────────
// La nave despeja SOLA las rocas marcadas como "objetivo" al pasar cerca (decisión
// del usuario: disparo automático, no apuntado manual — encaja con que el recorrido
// va sobre raíles). Mismo patrón que las estrellas fugaces: un LineSegments con
// degradado de color por vértice, sólo que aquí el disparo lo dispara la lógica del
// vuelo, no el azar.
// Criterio de disparo: ¿SE VE la roca ahora mismo?
// Dos intentos fallidos antes de dar con esto, y merece la pena dejarlo escrito:
//  1º disparaba cuando el progreso `t` llegaba al de la roca — o sea, con la nave a su
//     ALTURA. Como están a 11-33 unidades de lado, quedaban a casi 90°: todo el
//     disparo ocurría fuera de pantalla. Por eso no se veía nada.
//  2º comprobaba el ángulo contra el morro de la nave. Mejor, pero la cámara va detrás,
//     más alta y oscilando con el ratón, así que su encuadre NO es el del morro:
//     medido, 5 de 11 disparos seguían cayendo fuera (NDC hasta 1.88).
// Lo que se comprueba ahora es directamente la proyección al viewport, que es la
// pregunta de verdad. El margen 0.72 (en vez de 1.0) deja la roca holgadamente dentro
// del cuadro, no pegada al borde, para que se vea el impacto entero.
// 80 y no 62: con 62, dos de los once objetivos no llegaban a cumplir la condición
// nunca (pasaban del centro al borde del cuadro demasiado rápido) y se quedaban sin
// destruir justo en el camino. Cogiéndolas antes, están más centradas y entran todas.
const DISPARO_DIST = 80;
// 0.5, no 0.72: con 0.72 los impactos ocurrían cerca del borde del cuadro y se
// perdían de vista mientras vuelas. Con 0.5 caen en la mitad central de la pantalla.
const DISPARO_NDC  = 0.5;
// Pausa mínima entre disparos, en segundos. Sin ella se disparaba a todo lo que
// cumpliera la condición en el mismo frame, y con siete campos de roca en vez de dos
// eso son ráfagas de tres o cuatro seguidas: se convertía en una ametralladora de
// fondo y ningún impacto tenía peso. Con 0.85s cada derribo es su propio momento.
const DISPARO_PAUSA = 0.85;
let ultimoDisparo = -99;
// 14 huecos de rayo simultáneos. Medido: con 6 se producían 63 rechazos por pool lleno
// en una sola pasada y 1-3 objetivos se quedaban sin destruir. Al ampliar el alcance a
// 80 unidades muchas rocas pasan a ser elegibles a la vez, así que hace falta caudal.
// Cuesta nada: son 14 segmentos de línea en un único draw call.
const BOLT_MAX = 14;
// Proyectiles como PUNTOS con volumen, no como líneas.
// Antes eran LineSegments, y en WebGL el grosor de línea SIEMPRE es 1 píxel
// (linewidth se ignora en la práctica). Un hilo de 1px cruzando la pantalla en 0.15s
// es literalmente invisible: por eso no se veía ni un disparo. Cada rayo se dibuja
// ahora como 3 puntos brillantes en fila (cabeza + dos de estela), con tamaño en
// unidades de mundo, igual que la estela del motor.
const BOLT_PTS = 6;                       // puntos por rayo (cabeza + estela)
const boltGeo = new THREE.BufferGeometry();
const boltPos  = new Float32Array(BOLT_MAX*BOLT_PTS*3);
const boltSize = new Float32Array(BOLT_MAX*BOLT_PTS);
const boltFade = new Float32Array(BOLT_MAX*BOLT_PTS);
boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos,3).setUsage(THREE.DynamicDrawUsage));
boltGeo.setAttribute('aSize', new THREE.BufferAttribute(boltSize,1).setUsage(THREE.DynamicDrawUsage));
boltGeo.setAttribute('aFade', new THREE.BufferAttribute(boltFade,1).setUsage(THREE.DynamicDrawUsage));
const boltMat = new THREE.ShaderMaterial({
  uniforms: { uTex:{ value: GLOW_TEX }, uColor:{ value: new THREE.Color(0xffb066) }, uScale:{ value: 600 } },
  vertexShader: `
    attribute float aSize; attribute float aFade;
    uniform float uScale; varying float vFade;
    void main(){
      vFade = aFade;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D uTex; uniform vec3 uColor; varying float vFade;
    void main(){ gl_FragColor = vec4(uColor,1.0) * texture2D(uTex, gl_PointCoord) * vFade; }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const boltMesh = new THREE.Points(boltGeo, boltMat);
boltMesh.frustumCulled = false;
scene.add(boltMesh);

const bolts = Array.from({length:BOLT_MAX}, ()=>({
  activo:false, origen:new THREE.Vector3(), destino:new THREE.Vector3(), t:0, dur:0.16, rock:null,
}));

// Devuelve false si los 4 huecos están ocupados: la roca no marca disparado y se
// reintenta el frame siguiente (rarísimo, con 4 huecos para disparos que duran <0.3s).
function dispararA(rock){
  let libre = -1;
  for(let i=0;i<BOLT_MAX;i++) if(!bolts[i].activo){ libre = i; break; }
  if(libre === -1) return false;
  const b = bolts[libre];
  // Origen: un poco por delante del morro, en coordenadas de mundo.
  _tmp.set(0, 0, -1.6).applyQuaternion(ship.quaternion).add(ship.position);
  b.origen.copy(_tmp);
  b.destino.copy(rock.pos);
  // Mínimo 0.20s: por debajo de eso el proyectil cruza tan rápido que no da tiempo
  // ni a registrarlo mientras vuelas.
  b.dur = THREE.MathUtils.clamp(b.origen.distanceTo(b.destino)/85, 0.20, 0.40);
  b.t = 0; b.activo = true; b.rock = rock;
  rock.disparado = true;
  // Fogonazo en el morro: es lo que hace que el disparo se LEA aunque el proyectil
  // cruce rápido. Sin él sólo hay un punto que sale de la nada.
  const fog = new THREE.Sprite(new THREE.SpriteMaterial({
    map:GLOW_TEX, color:0xffd2a0, transparent:true, opacity:1,
    blending:THREE.AdditiveBlending, depthWrite:false,
  }));
  fog.position.copy(b.origen);
  fog.scale.setScalar(3.2);
  scene.add(fog);
  flashes.push({ sprite:fog, vida:0, dur:0.22 });
  SND.disparo();
  return true;
}

const flashes = [];    // destellos de impacto: se crean y se sueltan, son ~8-10 en toda la sesión

// Añade una capa de destello. `esc0` es el tamaño inicial y `crece` lo que se expande
// por segundo: son parámetros por capa porque una explosión creíble es la suma de
// varios ritmos —un núcleo que revienta y muere, una bola que se infla despacio, un
// anillo que sale disparado— y no un único sprite creciendo a velocidad fija.
// Las explosiones se calibraron sin bloom. Con él, sus cuatro capas aditivas se suman en
// coma flotante y el bloom las hinchaba hasta llenar la pantalla de blanco (en los planos
// de derribo de la cinemática no se veía ni el caza). Se atenúan en bloque.
const ESCALA_DESTELLO = Q.bloom ? 0.55 : 1;
function destello(pos, { tex=GLOW_TEX, color=0xffd9a0, esc0=4, crece=7, dur=0.6, op=0.9 }={}){
  op *= ESCALA_DESTELLO;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map:tex, color, transparent:true, opacity:op,
    blending:THREE.AdditiveBlending, depthWrite:false,
  }));
  s.position.copy(pos);
  s.scale.setScalar(esc0);
  scene.add(s);
  flashes.push({ sprite:s, vida:0, dur, crece, op });
  return s;
}

function explotarRoca(rock){
  rock.muerto = true;
  // Explosión POR CAPAS. Antes era un único sprite naranja que crecía y se apagaba, y
  // por eso "no era lo bastante espectacular": un solo elemento, un solo ritmo, y si
  // pasabas rápido no te enterabas. Ahora son cuatro cosas a la vez y a velocidades
  // distintas, que es como se lee una explosión de verdad.
  const k = 1 + rock.scale*0.55;                 // las rocas grandes revientan más
  // 1) Núcleo blanco: brutal e instantáneo. Es el frame que "marca" el impacto.
  destello(rock.pos, { color:0xffffff, esc0:2*k, crece:12*k, dur:0.16, op:1 });
  // 2) Bola de fuego: más lenta y cálida, la que sostiene el momento.
  destello(rock.pos, { color:0xffa040, esc0:3.5*k, crece:4*k, dur:0.85, op:0.95 });
  // 3) Onda expansiva: el anillo sale disparado y deja ver los escombros por el centro.
  destello(rock.pos, { tex:SHOCK_TEX, color:0xffd0a0, esc0:3*k, crece:17*k, dur:0.42, op:0.8 });
  // 4) Rescoldo: se queda un momento donde estaba la roca, para que al alejarte todavía
  //    quede la marca de que ahí había algo.
  destello(rock.pos, { color:0xff5a1e, esc0:2.2*k, crece:1.9*k, dur:1.5, op:0.55 });
  emitirEscombros(rock.pos, rock.scale);
  SND.impacto();
}

// ── Escombros: estalla la roca en fragmentos que salen despedidos y se apagan ──
// Mismo patrón que el humo (pool de partículas independientes con posición propia),
// pero con velocidad radial en vez de caída, y tono de roca en vez de gris.
const ESCOMBROS_MAX = 220;
const escGeo = new THREE.BufferGeometry();
const escPos  = new Float32Array(ESCOMBROS_MAX*3);
const escSize = new Float32Array(ESCOMBROS_MAX);
const escFade = new Float32Array(ESCOMBROS_MAX);
escGeo.setAttribute('position', new THREE.BufferAttribute(escPos,3).setUsage(THREE.DynamicDrawUsage));
escGeo.setAttribute('aSize', new THREE.BufferAttribute(escSize,1).setUsage(THREE.DynamicDrawUsage));
escGeo.setAttribute('aFade', new THREE.BufferAttribute(escFade,1).setUsage(THREE.DynamicDrawUsage));
const escMat = new THREE.ShaderMaterial({
  uniforms: { uTex:{ value: makeSmokeTexture() }, uColor:{ value: new THREE.Color(0xc9915a) }, uScale:{ value: 600 } },
  vertexShader: `
    attribute float aSize; attribute float aFade;
    uniform float uScale; varying float vFade;
    void main(){
      vFade = aFade;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D uTex; uniform vec3 uColor; varying float vFade;
    void main(){
      vec4 t = texture2D(uTex, gl_PointCoord);
      gl_FragColor = vec4(uColor, t.a * vFade);
    }`,
  transparent: true, depthWrite: false,
});
const escombrosMesh = new THREE.Points(escGeo, escMat);
escombrosMesh.frustumCulled = false;
scene.add(escombrosMesh);

const escombrosP = Array.from({length:ESCOMBROS_MAX}, ()=>({
  pos:new THREE.Vector3(), vel:new THREE.Vector3(), vida:0, maxVida:1, tam:1, viva:false,
}));
let escombrosCursor = 0, escombrosHabia = false;

function emitirEscombros(origen, tamano){
  // Más fragmentos, más grandes y con más vida que el primer intento: con 10 trocitos
  // diminutos que duraban medio segundo el estallido no se leía al pasar de largo.
  const n = 34 + Math.round(tamano*10);
  for(let k=0;k<n;k++){
    const e = escombrosP[escombrosCursor]; escombrosCursor = (escombrosCursor+1) % ESCOMBROS_MAX;
    e.pos.copy(origen);
    const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
    // Velocidades muy repartidas (elevando al cubo un aleatorio): la mayoría de trozos
    // sale lento y unos pocos salen disparadísimos. Con un rango estrecho todos los
    // fragmentos avanzaban en bloque y parecía una esfera inflándose, no un reventón.
    const spd = 4 + Math.pow(Math.random(), 3) * 34;
    e.vel.set(Math.sin(ph)*Math.cos(th), Math.cos(ph), Math.sin(ph)*Math.sin(th)).multiplyScalar(spd);
    e.vida = 0; e.maxVida = 1.0 + Math.random()*1.1;
    e.tam = (0.35 + Math.random()*0.6) * (0.7 + tamano*0.4);
    e.viva = true;
  }
}

// ── Polvo espacial: lo que da sensación real de velocidad ──
// Las partículas no se mueven; se "envuelven" alrededor de la cámara, así que el
// paralaje sale del movimiento de la nave y la densidad es constante en toda la ruta.
const DUST_COUNT = Q.polvo, DUST_BOX = 110, DUST_HALF = DUST_BOX/2;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_COUNT*3);
for(let i=0;i<DUST_COUNT*3;i++) dustPos[i] = (Math.random()-0.5)*DUST_BOX;
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos,3).setUsage(THREE.DynamicDrawUsage));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color:0x9fd8e8, size:0.42, map:STAR_TEX, sizeAttenuation:true, transparent:true,
  opacity:0.55, depthWrite:false, blending:THREE.AdditiveBlending,
}));
dust.frustumCulled = false;
scene.add(dust);

// ── Tráfico: otras naves circulando por la ruta ──
const TRAFFIC_COUNT = Q.trafico;
const traffic = [];
let trafficMesh = null;
const trafficGlowGeo = new THREE.BufferGeometry();
const trafficGlowPos = new Float32Array(TRAFFIC_COUNT*3);
trafficGlowGeo.setAttribute('position', new THREE.BufferAttribute(trafficGlowPos,3).setUsage(THREE.DynamicDrawUsage));
const trafficGlow = new THREE.Points(trafficGlowGeo, new THREE.PointsMaterial({
  map:GLOW_TEX, color:0x8fe6ff, size:2.4, sizeAttenuation:true,
  transparent:true, opacity:0.9, depthWrite:false, blending:THREE.AdditiveBlending,
}));
trafficGlow.frustumCulled = false;
scene.add(trafficGlow);

getModel('spaceship', m=>{
  if(!m) return;
  const baked = bakedGeometry(m);
  if(!baked) return;
  const mat = new THREE.MeshStandardMaterial({
    color:tono(0x2a3b47), metalness:metal(0.7), roughness:0.35,
    emissive:tono(0x0d1b24), emissiveIntensity:0.5,
  });
  trafficMesh = new THREE.InstancedMesh(baked.geo, mat, TRAFFIC_COUNT);
  trafficMesh.frustumCulled = false;
  trafficMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(trafficMesh);

  for(let i=0;i<TRAFFIC_COUNT;i++){
    const t = 0.05 + (i/TRAFFIC_COUNT)*0.9;
    const anchor = curve.getPointAt(t);
    const dir = new THREE.Vector3(Math.random()-0.5, (Math.random()-0.5)*0.3, Math.random()-0.5).normalize();
    traffic.push({
      anchor, dir,
      span: 90 + Math.random()*90,       // longitud del tramo antes de reaparecer
      u: Math.random(),                  // posición normalizada dentro del tramo
      speed: 0.035 + Math.random()*0.075,
      scale: 1.1 + Math.random()*2.2,
      offset: new THREE.Vector3((Math.random()-0.5)*40, (Math.random()-0.5)*26, (Math.random()-0.5)*40),
      pos: new THREE.Vector3(),
    });
  }
});

// ── PLATAFORMAS ───────────────────────────────────────────────────────────────
// Se usa dos veces: despegue al principio y aterrizaje al final, así que va como
// constructor en lugar de duplicar el bloque.
function construirPlataforma(pos, { radio = 7, color = 0xff6b4a, torres = true } = {}){
  const g = new THREE.Group();
  g.position.copy(pos);
  scene.add(g);
  const luces = [];

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(radio, radio*1.2, 1.3, 32),
    new THREE.MeshStandardMaterial({color:tono(0x1b2c38), metalness:metal(0.85), roughness:0.42})
  );
  // La plataforma es la superficie donde de verdad se ve la sombra de la nave: en
  // espacio abierto no hay nada sobre lo que proyectar.
  if(Q.sombras) deck.receiveShadow = true;
  g.add(deck);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radio*1.06, 0.22, 8, 48),
    new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.7, depthWrite:false})
  );
  rim.rotation.x = Math.PI/2; rim.position.y = 0.8;
  g.add(rim);

  const lightGeo = new THREE.SphereGeometry(0.3, 8, 8);
  for(let i=0;i<10;i++){
    const a = (i/10)*Math.PI*2;
    const l = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({color:0xffcf8a, transparent:true, opacity:1, depthWrite:false}));
    l.position.set(Math.cos(a)*radio*1.06, 1.1, Math.sin(a)*radio*1.06);
    l.userData.phase = i*0.6;
    g.add(l); luces.push(l);
  }
  const glow = new THREE.PointLight(color, 3.2, 40);
  glow.position.set(0, 3, 0);
  g.add(glow);

  if(torres) [-1, 1].forEach(sx=>{
    getModel('metal_support', mm=>{
      if(!mm) return;
      const w = normalizeModel(mm, 11);
      activarSombras(w);
      w.position.set(sx*(radio + 2.5), 5.5, 0);
      g.add(w);
    });
  });
  return { grupo: g, luces };
}

// ── HANGAR ────────────────────────────────────────────────────────────────────
// La nave ya no arranca flotando en el vacío: sale de un hangar cerrado. Además de
// quedar mejor, el espacio cerrado es lo que hace legible el humo de los motores
// (en campo abierto se disiparía sin leerse) y da superficies donde las sombras se
// ven de verdad.
// El hangar está lejos en Z (boca en z=100) para que, al salir, quede recorrido
// suficiente para trepar hasta el inicio de la ruta (0,3,60) sin un ángulo absurdo.
// Rayas de peligro para las puertas. Diagonales sobre un canvas, que se repite: es
// el detalle que hace que un panel liso se lea como "puerta industrial".
function makeStripeTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const cx = c.getContext('2d');
  cx.fillStyle = tonoCss(0x26313a); cx.fillRect(0,0,64,64);
  cx.fillStyle = tonoCss(0xc9962f);
  for(let i=-64;i<64;i+=18){
    cx.beginPath();
    cx.moveTo(i,0); cx.lineTo(i+9,0); cx.lineTo(i+9+64,64); cx.lineTo(i+64,64);
    cx.closePath(); cx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const STRIPE_TEX = makeStripeTexture();

// ── HANGARES ──────────────────────────────────────────────────────────────────
// Se construye dos veces (salida y llegada), así que va como función.
// Tres partes:
//  · interior cerrado — da superficies para sombras y confina el humo
//  · puertas correderas — se abren durante la secuencia
//  · fachada exterior con detalle — el hangar es un AGUJERO en un casco enorme, no
//    una caja suelta en el vacío. Sin esto se ve exactamente lo que se veía: flotando
//    en medio de la nada.
function construirHangar({ bocaZ, dirInterior, sueloY, techoY, semiancho = 15,
                           profundidad = 40, colorMarco = 0xff6b4a }){
  const g = new THREE.Group();
  scene.add(g);
  const W = semiancho, Y0 = sueloY, Y1 = techoY;
  const Z0 = bocaZ, Z1 = bocaZ + dirInterior*profundidad;
  const cz = (Z0+Z1)/2, cy = (Y0+Y1)/2, alto = Y1-Y0, largo = profundidad;

  const casco = new THREE.MeshStandardMaterial({ color:tono(0x1b2730), metalness:metal(0.75), roughness:0.55, side:THREE.DoubleSide });
  const panel = (w, h, pos, rot, mat)=>{
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat || casco);
    m.position.copy(pos); if(rot) m.rotation.copy(rot);
    if(Q.sombras) m.receiveShadow = true;
    g.add(m); return m;
  };

  // ── Interior ──
  panel(W*2, largo, new THREE.Vector3(0, Y0, cz), new THREE.Euler(-Math.PI/2, 0, 0));
  panel(W*2, largo, new THREE.Vector3(0, Y1, cz), new THREE.Euler( Math.PI/2, 0, 0));
  panel(largo, alto, new THREE.Vector3(-W, cy, cz), new THREE.Euler(0,  Math.PI/2, 0));
  panel(largo, alto, new THREE.Vector3( W, cy, cz), new THREE.Euler(0, -Math.PI/2, 0));
  panel(W*2, alto,  new THREE.Vector3(0, cy, Z1), new THREE.Euler(0, 0, 0));

  const costillaGeo = new THREE.BoxGeometry(0.7, alto, 0.7);
  const costillaMat = new THREE.MeshStandardMaterial({ color:tono(0x2c3d49), metalness:metal(0.85), roughness:0.4 });
  const NC = 8;
  const costillas = new THREE.InstancedMesh(costillaGeo, costillaMat, NC*2);
  const d = new THREE.Object3D();
  for(let i=0;i<NC;i++){
    const z = Z0 + dirInterior*(3 + (largo - 6)*(i/(NC-1)));
    [-1, 1].forEach((sx, k)=>{
      d.position.set(sx*(W - 0.4), cy, z); d.updateMatrix();
      costillas.setMatrixAt(i*2 + k, d.matrix);
    });
  }
  activarSombras(costillas); g.add(costillas);

  const tiraMat = new THREE.MeshBasicMaterial({ color:0x7fd4ff, transparent:true, opacity:0.75, depthWrite:false });
  [-1, 1].forEach(sx=>{
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, largo - 8), tiraMat);
    t.position.set(sx*(W - 0.9), Y1 - 2.5, cz);
    g.add(t);
  });

  [[0, Y1-2, Z0 + dirInterior*10], [0, Y1-2, Z1 - dirInterior*12]].forEach(([x,y,z])=>{
    const l = new THREE.PointLight(0x9fd8ff, 2.4, 55);
    l.position.set(x, y, z); g.add(l);
  });

  // ── Fachada: casco enorme con la boca recortada ──
  // Cuatro paneles alrededor del hueco (arriba, abajo, izquierda, derecha). Es la
  // forma barata de "recortar" un agujero rectangular sin geometría booleana.
  const FW = 118, ARRIBA = Y1 + 60, ABAJO = Y0 - 66;
  const zf = Z0 - dirInterior*0.6;   // ligeramente por fuera de la boca
  const fachadaMat = new THREE.MeshStandardMaterial({ color:tonoProfundo(0x1f2b34), metalness:metal(0.8), roughness:0.5 });
  // CAJAS, no planos. Con planos la fachada era una lámina sin canto: de lejos se leía
  // como un rectángulo recortado flotando. Con 9 unidades de fondo hay silueta lateral
  // y las luces la modelan.
  const FONDO = 9;
  const bloque = (w, h, x, y)=>{
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, FONDO), fachadaMat);
    m.position.set(x, y, zf - dirInterior*FONDO/2);
    if(Q.sombras){ m.castShadow = true; m.receiveShadow = true; }
    g.add(m);
  };
  bloque(FW - W, ARRIBA - ABAJO, -(W + (FW-W)/2), (ARRIBA+ABAJO)/2);
  bloque(FW - W, ARRIBA - ABAJO,  (W + (FW-W)/2), (ARRIBA+ABAJO)/2);
  bloque(W*2, ARRIBA - Y1, 0, (ARRIBA+Y1)/2);
  bloque(W*2, Y0 - ABAJO,  0, (Y0+ABAJO)/2);

  // Bloques de borde: sobresalen del rectángulo para ROMPER LA SILUETA. Sin esto el
  // contorno exterior es una caja perfecta y desde lejos canta como tal. Instanciados.
  const NB = 46;
  const bordes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1,1,1),
    new THREE.MeshStandardMaterial({ color:tonoProfundo(0x22303a), metalness:metal(0.8), roughness:0.5 }),
    NB
  );
  const db = new THREE.Object3D();
  for(let i=0;i<NB;i++){
    const lado = i % 4;                       // 0 izq, 1 der, 2 arriba, 3 abajo
    const sx = 6 + Math.random()*22, sy = 6 + Math.random()*22, sz = 4 + Math.random()*12;
    let x, y;
    if(lado === 0){ x = -FW + (Math.random()-0.7)*14; y = ABAJO + Math.random()*(ARRIBA-ABAJO); }
    else if(lado === 1){ x = FW + (Math.random()-0.3)*14; y = ABAJO + Math.random()*(ARRIBA-ABAJO); }
    else if(lado === 2){ x = (Math.random()-0.5)*FW*2; y = ARRIBA + (Math.random()-0.6)*16; }
    else { x = (Math.random()-0.5)*FW*2; y = ABAJO - (Math.random()-0.4)*16; }
    db.position.set(x, y, zf - dirInterior*(FONDO/2 + Math.random()*5));
    db.scale.set(sx, sy, sz);
    db.updateMatrix();
    bordes.setMatrixAt(i, db.matrix);
  }
  activarSombras(bordes);
  g.add(bordes);

  // Greebles: cajas de tamaños dispares sobre la fachada. Es LA técnica clásica para
  // que una superficie plana lea como una nave/estación gigante — sin ellos el casco
  // parece un cartón liso. Instanciadas: 1 draw call para las 260.
  const NG = 260;
  const greebles = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1,1,1),
    new THREE.MeshStandardMaterial({ color:tono(0x27333d), metalness:metal(0.85), roughness:0.45 }),
    NG
  );
  for(let i=0;i<NG;i++){
    // Se reparten por la fachada evitando el hueco de la boca
    let x, y, intentos = 0;
    do {
      x = (Math.random()-0.5)*FW*2;
      y = ABAJO + Math.random()*(ARRIBA-ABAJO);
      intentos++;
    } while(intentos < 12 && Math.abs(x) < W+2 && y > Y0-2 && y < Y1+2);
    const sx = 1.2 + Math.random()*7, sy = 1.2 + Math.random()*7, sz = 0.5 + Math.random()*2.6;
    d.position.set(x, y, zf - dirInterior*(sz/2));
    d.rotation.set(0, 0, Math.random() < 0.25 ? Math.PI/2 : 0);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    greebles.setMatrixAt(i, d.matrix);
  }
  d.scale.set(1,1,1); d.rotation.set(0,0,0);
  activarSombras(greebles); g.add(greebles);

  // Balizas de aproximación en el borde del hueco
  const balizas = [];
  const balizaGeo = new THREE.SphereGeometry(0.55, 8, 8);
  for(let i=0;i<8;i++){
    const lado = i % 2 ? 1 : -1;
    const b = new THREE.Mesh(balizaGeo, new THREE.MeshBasicMaterial({ color:colorMarco, transparent:true, opacity:1, depthWrite:false }));
    b.position.set(lado*(W+1.5), Y0 + 2 + (alto-4)*((i>>1)/3), zf - dirInterior*1.2);
    b.userData.phase = i*0.55;
    g.add(b); balizas.push(b);
  }

  // ── Puertas correderas ──
  const puertaMat = new THREE.MeshStandardMaterial({ map:STRIPE_TEX, metalness:0.6, roughness:0.55 });
  STRIPE_TEX.repeat.set(4, 2);
  const puertas = [-1, 1].map(lado=>{
    const p = new THREE.Mesh(new THREE.BoxGeometry(W, alto, 1.0), puertaMat);
    if(Q.sombras){ p.castShadow = true; p.receiveShadow = true; }
    p.position.set(lado*W/2, cy, zf - dirInterior*0.9);
    p.userData.cerrada = lado*W/2;
    p.userData.abierta = lado*(W*1.55);
    g.add(p); return p;
  });
  // apertura: 0 = cerradas, 1 = abiertas del todo
  const setApertura = v=>{
    const k = smoothstep01(v);
    for(const p of puertas) p.position.x = THREE.MathUtils.lerp(p.userData.cerrada, p.userData.abierta, k);
  };
  setApertura(0);

  return { grupo:g, setApertura, balizas };
}

// Hangar de salida: boca en z=100, interior hacia +z. Está lejos para que, al salir,
// quede recorrido suficiente para trepar hasta el inicio de la ruta (0,3,60).
const HANGAR = { semiancho:15, suelo:-36, techo:-20, boca:100, fondo:140 };
const PAD_POS = new THREE.Vector3(0, -34, 120);
const hangarSalida = construirHangar({
  bocaZ:HANGAR.boca, dirInterior:1, sueloY:HANGAR.suelo, techoY:HANGAR.techo,
  semiancho:HANGAR.semiancho, profundidad:HANGAR.fondo - HANGAR.boca, colorMarco:0xff6b4a,
});

const { grupo: padGroup, luces: padLights } = construirPlataforma(PAD_POS, { color:0xff6b4a });

// Hangar de llegada: la nave viene hacia -z, así que la boca mira a +z y el interior
// se adentra hacia -z. En turquesa para leerse como "llegada" frente al naranja.
const LAND_POS = new THREE.Vector3(0, -9, -288);
const HANGAR_LLEGADA = { semiancho:15, suelo:-10, techo:6, boca:-278, profundidad:40 };
const hangarLlegada = construirHangar({
  bocaZ:HANGAR_LLEGADA.boca, dirInterior:-1, sueloY:HANGAR_LLEGADA.suelo,
  techoY:HANGAR_LLEGADA.techo, semiancho:HANGAR_LLEGADA.semiancho,
  profundidad:HANGAR_LLEGADA.profundidad, colorMarco:0x3fd8c2,
});
const { grupo: landGroup, luces: landLights } = construirPlataforma(LAND_POS, { radio:8, color:0x3fd8c2, torres:false });

// Bocas de los hangares, para apagarlos por distancia en el bucle.
const BOCA_SALIDA  = new THREE.Vector3(0, (HANGAR.suelo + HANGAR.techo)/2, HANGAR.boca);
const BOCA_LLEGADA = new THREE.Vector3(0, (HANGAR_LLEGADA.suelo + HANGAR_LLEGADA.techo)/2, HANGAR_LLEGADA.boca);

// ── Curva de aterrizaje ──
// Empieza EXACTAMENTE donde el modo scroll deja la nave (getPointAt(0.999), porque el
// bucle usa min(0.999, progress+0.015)), así el relevo vuelo → aterrizaje no da tirón,
// igual que hicimos con el despegue. Los dos últimos puntos son casi verticales para
// que la aproximación final sea un descenso y no un picado contra la plataforma.
const FIN_RUTA = curve.getPointAt(0.999);
const landingCurve = new THREE.CatmullRomCurve3([
  FIN_RUTA.clone(),
  FIN_RUTA.clone().add(new THREE.Vector3(0, -0.6, -9)),
  LAND_POS.clone().add(new THREE.Vector3(0, 6.0, 14)),  // llega frenando
  LAND_POS.clone().add(new THREE.Vector3(0, 2.6, 5)),
  LAND_POS.clone().add(new THREE.Vector3(0, 1.35, 0.6)),
  LAND_POS.clone().add(new THREE.Vector3(0, 1.15, 0)),  // posada, 0.50 sobre la cubierta
], false, 'catmullrom', 0.25);

// La curva termina con dos puntos SOBRE la ruta principal para que la tangente final
// coincida con la del recorrido: así el relevo intro → scroll no da un tirón.
// Perfil: sube en vertical dentro del hangar, se inclina, sale por la boca (z=100) y
// sólo entonces trepa hacia la ruta. La versión anterior subía recta hasta y=0, que
// con el hangar puesto sería atravesar el techo (y=-20).
const launchCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, -32.2, 120),   // en la plataforma
  new THREE.Vector3(0, -28.5, 119),   // se eleva dentro del hangar
  new THREE.Vector3(0, -26.5, 111),   // se inclina hacia la salida
  new THREE.Vector3(0, -26.0,  99),   // cruza la boca
  new THREE.Vector3(0, -20.0,  88),   // fuera, empieza a trepar
  new THREE.Vector3(0, -10.0,  78),
  new THREE.Vector3(0,  -1.0,  69),
  curve.getPointAt(0),
  curve.getPointAt(0.015),
], false, 'catmullrom', 0.4);

// ── Labels DOM ──
const wlContainer = document.getElementById('waypointLabels');
WAYPOINTS.forEach(wp=>{
  const el = document.createElement('div');
  el.className = 'wl';
  el.textContent = wp.title;
  wlContainer.appendChild(el);
});
const wlEls = [...wlContainer.querySelectorAll('.wl')];

// ── Panel ──
const infoPanel = document.getElementById('infoPanel');
const panelBody = document.getElementById('panelBody');
let activeIdx = -1;
function renderPanel(wp){
  let html = `<span class="ptag">${wp.tag}</span><div class="ptitle">${wp.title}</div>`;
  if(wp.stats) html += `<div class="tags" style="margin-bottom:.8rem">` + wp.stats.map(s=>`<span class="tag">${s.n} ${s.l}</span>`).join('') + `</div>`;
  if(wp.items) wp.items.forEach(it=> html += `<div class="pi"><div class="pit">${it.t}</div><div class="pis">${it.s}</div><div class="pid">${it.d}</div></div>`);
  if(wp.tags) html += `<div class="tags">` + wp.tags.map(t=>`<span class="tag">${t}</span>`).join('') + `</div>`;
  panelBody.innerHTML = html;
}
function setActiveWaypoint(idx){
  if(idx === activeIdx) return;
  if(idx >= 0) SND.seccion();       // aviso al entrar en una sección
  activeIdx = idx;
  if(idx<0){ infoPanel.classList.remove('on'); }
  else{ renderPanel(WAYPOINTS[idx]); infoPanel.classList.add('on'); }
  wlEls.forEach((el,i)=> el.classList.toggle('active', i===idx));
}

// ══ SONIDO ═════════════════════════════════════════════════════════════════════
// Rediseñado tras feedback: el motor continuo (ruido filtrado + sierras graves
// sonando todo el rato) resultaba molesto, no "cozy". Se ha quitado del todo — nada
// suena de forma continua salvo el pad ambiental. Lo que queda son golpes puntuales
// (ignición, puertas, posado, blips de sección) rediseñados más suaves, graves y con
// ataques largos: nada de barridos agudos ni transitorios secos.
//
// La música también es sintetizada (ver más abajo): así comparte el nodo master con
// los efectos, el silencio es un único camino, y el nivel es exactamente el elegido.
//
// El AudioContext NO se puede crear antes de un gesto del usuario (los navegadores lo
// bloquean), así que se monta en el primer click, que es justo el de "Iniciar".
// Música ambiental SINTETIZADA, no un fichero.
// Un mp3 masterizado va cerca de fondo de escala y aplastaba los efectos por mucho que
// se bajara la ganancia; además pesaba 4.4 MB de descarga. Generándola aquí el nivel
// es exactamente el que se decide, pesa 0 bytes, y no se acaba nunca ni tiene costura
// de bucle. Progresión lenta de acordes menores con filtro que respira: lofi/planetario.
// 0.18: el pad vive en 82-260 Hz, exactamente donde estaban los efectos, y los
// enmascaraba. Bajarlo y subir los efectos es lo que hace que se oigan las dos cosas.
const MUSIC_VOL = 0.18;
// Acordes en Hz (La menor → Fa → Do → Sol, todo grave). Cada uno dura ACORDE_SEG.
const ACORDES = [
  [110.00, 164.81, 196.00, 261.63],   // Am
  [ 87.31, 130.81, 174.61, 220.00],   // F
  [ 98.00, 146.83, 196.00, 246.94],   // G
  [ 82.41, 123.47, 164.81, 207.65],   // Em
];
const ACORDE_SEG = 16;

const SND = (()=>{
  let ctx = null, master = null, calidez = null, listo = false;
  // SILENCIADO SIEMPRE AL CARGAR, sin excepción.
  // Antes recordaba la elección en localStorage, pero eso significa que quien activara
  // el sonido una vez lo tenía encendido en cada visita posterior — justo lo que no se
  // quiere en un portfolio. Ahora el sonido es algo que se enciende a propósito en
  // cada visita; el botón sigue guardando el estado sólo para la sesión en curso.
  let silenciado = true;

  let musicGain = null, musicNivel = MUSIC_VOL;
  let padOscs = [], padSubs = [], acordeIdx = 0, acordeTimer = null;
  let vueloGain = null, vueloFiltro = null;   // roce de vuelo (no un motor)

  // Ruido rosa (Paul Kellet), sólo para los golpes puntuales ahora — ya no hay ningún
  // bucle continuo. El blanco suena a "shhh" agudo y metálico; el rosa tiene más
  // energía en graves y encaja mejor con un tono cálido.
  function bufferRuido(segundos = 1.5){
    const n = Math.floor(ctx.sampleRate * segundos);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0=0, b1=0, b2=0;
    for(let i=0;i<n;i++){
      const w = Math.random()*2 - 1;
      b0 = 0.99765*b0 + w*0.0990460;
      b1 = 0.96300*b1 + w*0.2965164;
      b2 = 0.57000*b2 + w*1.0526913;
      d[i] = (b0 + b1 + b2 + w*0.1848) * 0.16;
    }
    return buf;
  }

  function init(){
    if(listo) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;                       // navegador sin Web Audio: se sigue sin sonido
    ctx = new AC();
    listo = true;
    master = ctx.createGain();
    master.gain.value = silenciado ? 0 : 0.85;
    // Filtro de "calidez" en la salida de TODOS los golpes: corta agudos por encima
    // de ~3.4kHz. Es lo que separa un efecto seco/digital de uno cálido y amortiguado.
    calidez = ctx.createBiquadFilter();
    calidez.type = 'lowpass'; calidez.frequency.value = 3400; calidez.Q.value = 0.4;
    calidez.connect(master);
    master.connect(ctx.destination);

    // ── Pad ambiental sintetizado ──
    // Cuatro voces por acorde + un sub grave. Filtro pasa-bajos con LFO muy lento para
    // que "respire", que es lo que le da el aire lofi en vez de sonar a órgano plano.
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    const padLp = ctx.createBiquadFilter();
    padLp.type = 'lowpass'; padLp.frequency.value = 700; padLp.Q.value = 0.7;
    padLp.connect(musicGain).connect(master);

    const lfoFiltro = ctx.createOscillator(); lfoFiltro.frequency.value = 0.035;
    const lfoFiltroG = ctx.createGain(); lfoFiltroG.gain.value = 330;
    lfoFiltro.connect(lfoFiltroG).connect(padLp.frequency);
    lfoFiltro.start();

    const acorde = ACORDES[0];
    for(let i=0;i<4;i++){
      // Dos osciladores por voz, ligeramente desafinados: el batido entre ambos es lo
      // que engorda el sonido y evita que suene a tono puro de sintetizador barato.
      const g = ctx.createGain();
      g.gain.value = 0.16 / (1 + i*0.35);          // las voces agudas, más bajas
      g.connect(padLp);
      const par = [];
      for(let k=0;k<2;k++){
        const o = ctx.createOscillator();
        o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = acorde[i] * (k ? 1.004 : 1);
        o.connect(g); o.start();
        par.push(o);
      }
      // LFO de amplitud por voz, cada una a su ritmo: entran y salen entre ellas.
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.04 + i*0.021;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.07 / (1 + i*0.35);
      lfo.connect(lfoG).connect(g.gain); lfo.start();
      padOscs.push(par);
    }
    // Sub: da el peso "planetario" sin ensuciar la mezcla.
    const subG = ctx.createGain(); subG.gain.value = 0.13; subG.connect(padLp);
    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = acorde[0] / 2;
    sub.connect(subG); sub.start();
    padSubs.push(sub);

    musicGain.gain.setTargetAtTime(MUSIC_VOL, ctx.currentTime, 4);   // entra despacio
    acordeTimer = setInterval(cambiarAcorde, ACORDE_SEG * 1000);

    // ── Roce de vuelo ──
    // Lo que faltaba: sensación de que la nave se mueve. Pero NO es el motor de antes
    // (ruido grave con sierras, que resultaba molesto): es un siseo agudo y suave,
    // tipo aire, muy filtrado y a volumen bajo. Se modula sólo con la velocidad, así
    // que en reposo desaparece por completo en vez de zumbar sin parar.
    const rv = ctx.createBufferSource();
    rv.buffer = bufferRuido(3); rv.loop = true;
    vueloFiltro = ctx.createBiquadFilter();
    vueloFiltro.type = 'bandpass'; vueloFiltro.frequency.value = 1400; vueloFiltro.Q.value = 0.5;
    vueloGain = ctx.createGain(); vueloGain.gain.value = 0;
    rv.connect(vueloFiltro).connect(vueloGain).connect(master);
    rv.start();
  }

  // Transición de acorde: se desliza la frecuencia de cada oscilador en 3.5s. Nada de
  // saltos, para que el cambio se sienta como una marea y no como un corte.
  function cambiarAcorde(){
    if(!listo) return;
    acordeIdx = (acordeIdx + 1) % ACORDES.length;
    const ac = ACORDES[acordeIdx], t = ctx.currentTime;
    padOscs.forEach((par, i)=> par.forEach((o, k)=>{
      o.frequency.setTargetAtTime(ac[i] * (k ? 1.004 : 1), t, 3.5);
    }));
    padSubs.forEach(s=> s.frequency.setTargetAtTime(ac[0]/2, t, 3.5));
  }

  // Ducking: la música se aparta un momento para dejar sitio al efecto y vuelve sola.
  // Es lo que hace que un golpe se oiga sin tener que subirlo hasta molestar.
  function duck(factor = 0.4, mantener = 0.35){
    if(!musicGain) return;
    const t = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setTargetAtTime(musicNivel*factor, t, 0.04);
    musicGain.gain.setTargetAtTime(musicNivel, t + mantener, 0.30);
  }

  // Rampa suave: evita los clics que salen al cambiar ganancias de golpe.
  const rampa = (param, v, t = 0.08)=>{
    if(listo) param.setTargetAtTime(v, ctx.currentTime, t);
  };

  function golpeRuido({ dur = 0.6, f0 = 400, f1 = 2200, q = 1.0, vol = 0.3, tipo = 'lowpass', ataque = 0.25 }){
    if(!listo || silenciado) return;
    // Los golpes de ruido son los sonidos con cuerpo, así que son los que apartan la
    // música. Los tonos cortos (blips, disparo) no hacen ducking: sería un bombeo
    // constante y molesto.
    duck(0.4, Math.min(dur, 0.5));
    const s = ctx.createBufferSource(); s.buffer = bufferRuido(Math.max(dur, 0.3));
    const f = ctx.createBiquadFilter(); f.type = tipo; f.Q.value = q;
    const t = ctx.currentTime;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur*ataque);   // ataque largo = suave, sin "clic"
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(calidez);
    s.start(t); s.stop(t + dur + 0.05);
  }

  function tono({ f = 660, dur = 0.22, vol = 0.06, tipo = 'sine', f2 = null, ataque = 0.05 }){
    if(!listo || silenciado) return;
    const o = ctx.createOscillator(); o.type = tipo;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(f, t);
    if(f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur*ataque);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(calidez);
    o.start(t); o.stop(t + dur + 0.05);
  }

  return {
    init(){
      init();
      if(listo && ctx.state === 'suspended') ctx.resume();
    },
    get disponible(){ return listo; },
    get silenciado(){ return silenciado; },
    alternarSilencio(){
      silenciado = !silenciado;
      // Sin persistir: cada visita arranca en silencio a propósito (ver arriba).
      // Un solo camino: la música también cuelga de `master`, así que basta con esto.
      if(listo) rampa(master.gain, silenciado ? 0 : 0.85, 0.12);
      return silenciado;
    },
    // Nivel base de la música (p.ej. bajarlo al posarse para el momento final).
    musicaVolumen(v){
      musicNivel = v;
      if(musicGain) rampa(musicGain.gain, v, 0.4);
    },
    // Roce de vuelo, llamado cada frame. velocidad 0..1
    vuelo(velocidad){
      if(!listo || !vueloGain) return;
      rampa(vueloGain.gain, velocidad * 0.055, 0.25);
      rampa(vueloFiltro.frequency, 900 + velocidad*1600, 0.3);
    },
    // Volúmenes subidos 3-4x y llevados a MEDIOS. Antes vivían por debajo de 500 Hz,
    // el mismo sitio que el pad, así que quedaban enmascarados: sonaban, pero no se
    // oían. Siguen siendo cálidos (ataques largos, filtro de agudos), sólo que ahora
    // ocupan su propio hueco en la mezcla.
    arranque(){ tono({ f:196, f2:392, dur:1.1, vol:0.20, tipo:'sine', ataque:0.3 });
                tono({ f:294, f2:587, dur:1.4, vol:0.13, tipo:'triangle', ataque:0.35 }); },
    ignicion(){ golpeRuido({ dur:2.0, f0:180, f1:900, q:0.7, vol:0.42, ataque:0.3 });
                tono({ f:98, f2:147, dur:1.6, vol:0.16, tipo:'sine', ataque:0.25 }); },
    puerta(){   golpeRuido({ dur:1.4, f0:420, f1:120, q:1.1, vol:0.24, ataque:0.25 }); },
    whoosh(i){  golpeRuido({ dur:1.1, f0:400, f1:1400*Math.max(i,0.3), q:0.8, vol:0.26*Math.max(i,0.3), ataque:0.35 }); },
    posado(){   golpeRuido({ dur:0.7, f0:520, f1:90, q:0.9, vol:0.34, ataque:0.15 });
                tono({ f:147, f2:98, dur:0.6, vol:0.16, tipo:'sine', ataque:0.12 }); },
    blip(){     tono({ f:784, f2:1046, dur:0.18, vol:0.10, tipo:'sine', ataque:0.15 }); },
    seccion(){  tono({ f:523, f2:784, dur:0.32, vol:0.13, tipo:'sine', ataque:0.2 }); },
    // Disparo e impacto: en medios para que destaquen sobre el pad grave, pero con
    // forma redondeada — ni "pew-pew" metálico ni explosión de videojuego.
    disparo(){  tono({ f:880, f2:440, dur:0.16, vol:0.16, tipo:'sine', ataque:0.12 }); },
    impacto(){  golpeRuido({ dur:0.5, f0:900, f1:140, q:0.8, vol:0.34, ataque:0.12 });
                tono({ f:196, f2:98, dur:0.45, vol:0.14, tipo:'sine', ataque:0.1 }); },
  };
})();

// ── Estado: idle (portada) → launch (despegue) → free (scroll) → landing → landed ──
const LAUNCH_DUR = 7.0;
const LANDING_DUR = 7.5;
// Se dispara un pelín antes del 100% para que el aterrizaje no dependa de que el
// suavizado exponencial de `progress` llegue exactamente a 1 (nunca llega del todo).
const LANDING_TRIGGER = 0.985;
let mode = 'idle', launchT = 0, landT = 0;
const startOverlay = document.getElementById('startOverlay');
const speedHint    = document.getElementById('speedHint');
const launchStatus = document.getElementById('launchStatus');
const rumbleEl     = document.getElementById('rumble');


const LAUNCH_CUES = [
  [0.00,'Secuencia de encendido'], [0.09,'Motores al 100%'], [0.22,'Despegue'],
  [0.50,'Abandonando la plataforma'], [0.78,'Rumbo fijado'],
];
let lastCue = null;

// ── Compuerta de carga ──
// Con los .glb incrustados estaban listos al instante. Ahora vienen por red, así que
// hay que impedir el despegue hasta tenerlos: si no, la nave arrancaría sin modelo.
let assetsReady = false;
const loadPct = document.getElementById('loadPct');
const tiPulsa = document.getElementById('tiPulsa');
const tiSonido = document.getElementById('tiSonido');
// Se lee aquí y no se reutiliza `esTactil` (declarada más abajo): usarla antes de su
// declaración rompería por la zona muerta temporal.
const TEXTO_PULSA = matchMedia('(pointer: coarse)').matches ? 'Toca para continuar' : 'Pulsa K para continuar';
loadManager.onProgress = (_url, cargados, total)=>{
  if(loadPct) loadPct.textContent = Math.round((cargados/total)*100) + '%';
};
loadManager.onLoad = ()=>{
  assetsReady = true;
  tiPulsa.classList.remove('cargando');
  tiPulsa.textContent = TEXTO_PULSA;
};
loadManager.onError = url=>{
  assetError(`⚠ Falló <b>${url.split('/').pop()}</b>`);
  // Aunque falte una pieza, se deja continuar: el resto de la escena es utilizable.
  loadManager.onLoad();
};

// El despegue en sí. Separado de startExperience porque ahora entre medias puede ir
// la intro, y al terminarla hay que arrancar desde aquí.
function lanzarDespegue(){
  if(mode !== 'idle') return;
  mode = 'launch'; launchT = 0;
  launchStatus.classList.add('on');
  speedHint.classList.add('hide');   // "scroll para avanzar" aún no aplica: manda la secuencia
  SND.init();
  SND.ignicion();
  setTimeout(()=> SND.puerta(), 700);   // las puertas empiezan a abrir en launchT≈0.06
}

// ── Intro estilo Star Wars ──
// Se reproduce SIEMPRE, también al recargar. Es saltable desde el primer segundo con
// click, tecla, rueda o el botón "Saltar intro", que es lo que evita que se haga
// pesada en visitas repetidas.
// Duración: 4.4s de línea azul + 30s de crawl (hasta 34.4s) + cartel que entra en
// 33.4s y dura 3.6s → ≈37s en total.
const crawlScreen = document.getElementById('crawlScreen');
const CRAWL_MS = 37200;
let crawlTimer = null, arrancado = false;

// Los oyentes de "saltar" se quitan explícitamente al terminar en vez de fiarse de
// {once:true}. Con `once`, si la intro se saltaba con el BOTÓN, los de teclado y
// rueda se quedaban colgados sin consumir; y al reiniciar el recorrido se añadía otro
// juego encima. Se acumulaban en cada vuelta.
function quitarOyentesIntro(){
  crawlScreen.removeEventListener('click', terminarIntro);
  removeEventListener('keydown', terminarIntro);
  removeEventListener('wheel', terminarIntro);
  removeEventListener('touchstart', terminarIntro);
}
function terminarIntro(){
  if(!crawlScreen.classList.contains('on') || crawlScreen.classList.contains('out')) return;
  clearTimeout(crawlTimer);
  quitarOyentesIntro();
  iniciarEnfoque();   // mientras el crawl se funde, la escena pasa de píxel a nítida
  // `.out` gana a `.on` por orden en la hoja, así que apaga el panel sin quitar `on`
  // (las animaciones del texto cuelgan de `on` y quitarlo las cortaría de golpe).
  crawlScreen.classList.add('out');
  setTimeout(()=>{
    crawlScreen.classList.remove('on', 'out');
    crawlScreen.setAttribute('aria-hidden', 'true');   // vuelve a salir del árbol de accesibilidad
  }, 1500);
  lanzarDespegue();
}
function reproducirIntro(){
  quitarOyentesIntro();               // por si quedara alguno de una vuelta anterior
  crawlScreen.classList.remove('out');
  crawlScreen.classList.add('on');
  crawlScreen.setAttribute('aria-hidden', 'false');
  crawlTimer = setTimeout(terminarIntro, CRAWL_MS);
  crawlScreen.addEventListener('click', terminarIntro);
  addEventListener('keydown', terminarIntro);
  addEventListener('wheel',   terminarIntro, { passive:true });
  addEventListener('touchstart', terminarIntro, { passive:true });
}

// El botón de silencio. En un portfolio esto no es opcional: mucha gente abre pestañas
// en silencio y un sitio que suena sin permiso se cierra. La preferencia se recuerda.
const muteBtn = document.getElementById('muteBtn');
function pintarMute(){
  const s = SND.silenciado;
  if(tiSonido){
    tiSonido.innerHTML = 'M · Sonido: <b>' + (s ? 'No' : 'Sí') + '</b>';
    tiSonido.setAttribute('aria-pressed', s ? 'false' : 'true');
  }
  muteBtn.textContent = s ? '♪ Silencio' : '♪ Sonido';
  muteBtn.setAttribute('aria-pressed', s ? 'true' : 'false');
}
pintarMute();
muteBtn.addEventListener('click', e=>{ e.stopPropagation(); SND.alternarSilencio(); pintarMute(); });
addEventListener('keydown', e=>{ if(e.key === 'm' || e.key === 'M'){ SND.alternarSilencio(); pintarMute(); } });

// El sonido se decide en la propia portada (M o el botón de abajo); aquí sólo se arranca
// con lo que haya elegido. Sigue empezando en silencio.
function startExperience(){
  if(arrancado || !assetsReady) return;
  arrancado = true;
  SND.init();          // el gesto de este click/tecla es lo que desbloquea el audio
  SND.arranque();      // confirmación sonora de que la experiencia empieza
  // Parpadeo rápido de confirmación (el "start" de los juegos) antes de la intro.
  tiPulsa.classList.add('pulsado');
  setTimeout(arrancarIntro, 650);
}
function arrancarIntro(){
  tiPulsa.classList.remove('pulsado');
  // El crawl (negro opaco, z 600) entra con fundido ENCIMA de la portada y de la escena
  // pixelada: se lee como un fundido a negro. La portada no se retira hasta que el crawl
  // ya cubre del todo, así que nunca asoma la nave parada sin pixelar.
  reproducirIntro();
  setTimeout(()=>{
    startOverlay.classList.add('out');
    startOverlay.style.display = 'none';
    document.body.classList.remove('en-portada');
  }, 620);            // 550ms de fundido del crawl + margen
}
// Entrar: K (el guiño a los LEGO de PC), Enter o espacio, o un click/toque en la portada.
// El botón de sonido para el click en seco: si no, cambiar el sonido arrancaría la intro.
tiSonido.addEventListener('click', e=>{ e.stopPropagation(); SND.alternarSilencio(); pintarMute(); });
startOverlay.addEventListener('click', ()=> startExperience());
addEventListener('keydown', e=>{
  if(mode !== 'idle' || arrancado || startOverlay.style.display === 'none') return;
  if(e.key === 'k' || e.key === 'K' || e.key === 'Enter' || (e.key === ' ' && e.target === document.body)){
    e.preventDefault(); startExperience();
  }
});

function finishLaunch(){
  mode = 'free';
  launchStatus.classList.remove('on');
  rumbleEl.style.opacity = 0;
  speedHint.classList.remove('hide');  // ya se pilota con scroll: se vuelve a ofrecer
}

// ══ CINEMÁTICAS ════════════════════════════════════════════════════════════════
// El recorrido es lineal, así que los momentos fuertes van guionizados: la cámara
// deja de seguir a la nave, se coloca donde interesa, ocurre algo, y devuelve el
// control. Es el mismo patrón que ya usan despegue y aterrizaje, generalizado.
//
// Durante una cinemática el scroll se bloquea y el progreso avanza SOLO, a ritmo
// propio. Al terminar hay que reposicionar la barra de scroll para que coincida con
// el progreso alcanzado; si no, al devolver el control la nave volaría hacia atrás
// hasta reencontrarse con donde está la rueda.
const CINEMATICAS = [
  { t:0.30, dur:9.5,  nombre:'combate', avance:0.0055, hecha:false },
  { t:0.52, dur:12.0, nombre:'agujero', avance:0.0040, hecha:false },
];
let cineIdx = -1, cineT = 0;

function iniciarCine(i){
  if(mode !== 'free') return;
  const c = CINEMATICAS[i];
  if(c.hecha) return;
  c.hecha = true;
  cineIdx = i; cineT = 0;
  agujeroSaltado = false;
  mode = 'cine';
  setActiveWaypoint(-1);
  speedHint.classList.add('hide');
  if(c.nombre === 'combate'){
    prepararCombate();
    if(enemigos.length){
      // Colocar los cazas YA: si no, el primer fotograma los dibuja en el origen del
      // mundo hasta que el bucle los sitúa.
      const t0 = Math.min(0.999, progress + 0.015);
      actualizarCombate(0, c.dur, 0, curve.getPointAt(t0, _p), curve.getTangentAt(t0, _tan).normalize());
      director.start(guionCombate(), ctxCombate);
    }
    // Si el modelo del caza no llegó a cargar no hay nada que enseñar: en vez de
    // dejar la cámara nueve segundos y medio dando vueltas sobre el vacío, se
    // devuelve el control y el recorrido sigue como si el beat no existiera.
    if(!enemigos.length){ mode = 'free'; speedHint.classList.remove('hide'); cineIdx = -1; return; }
  }else if(c.nombre === 'agujero'){
    ctxAgujero.actualizar(0);
    director.start(guionAgujero(), ctxAgujero);
  }
}

function finCine(){
  mode = 'free';
  director.end();
  // Ya no hay barra de scroll que resincronizar: el progreso es la única fuente de
  // verdad, así que al devolver el control se sigue exactamente desde donde quedó.
  targetProgress = progress;
  speedHint.classList.remove('hide');
  cineIdx = -1;
}

// ── Beat 1: combate ──
// Tres cazas cruzan por delante; la nave los derriba. Se reutilizan los sistemas ya
// existentes de rayos, destellos y escombros, que ya están verificados como visibles.
const enemigos = [];
// Caza enemigo con SILUETA PROPIA.
//
// Aquí estaba el error que hacía que el combate quedara mal: se usaba `enemy_flying`
// del kit dando por hecho que "enemy" = nave enemiga. NO lo es. Renderizando los
// modelos uno a uno se ve que los tres "Enemy" del kit (Flying, Small, Large) son
// BICHOS ALIENÍGENAS verdes; `enemy_flying` tiene proporciones 0.34/0.33/1.00, o sea
// sección cuadrada y alargada — un gusano, no un fuselaje. De ahí el "modelo extraño".
//
// Los cazas de verdad son las variantes de Spaceship, planas y con envergadura. Se usa
// Spaceship-Jqfed124pQ (aquí enemy_fighter): silueta afilada y agresiva, distinta de la
// naranja del jugador, y sólo 2814 triángulos. Su morro apunta a -Z igual que la nave
// protagonista —comprobado renderizando con marcas de color en ambos extremos del eje—
// así que la corrección `rotateY(Math.PI)` que ya había vale tal cual.
let enemigoGeo = null, enemigoMat = null;
getModel('enemy_fighter', m=>{
  if(!m) return;
  const baked = bakedGeometry(m);
  if(!baked) return;
  enemigoGeo = baked.geo;
  // Se parte del material propio del modelo (trae su atlas de color y está pensado para
  // verse bien) en vez de inventar uno gris. Las dos iteraciones anteriores fallaron por
  // eso: un casco liso pintado a mano o se pierde contra el negro o, con emisivo alto,
  // tiñe el modelo entero de un rojo plano. El emisivo se queda muy bajo, sólo para que
  // el casco no se apague del todo en las zonas de sombra.
  enemigoMat = baked.mat.clone();
  enemigoMat.emissive = new THREE.Color(0xff3a1e);
  enemigoMat.emissiveIntensity = 0.12;
});

// ── EL COMBATE, REPLANTEADO ───────────────────────────────────────────────────
// Cuatro intentos anteriores fallaron todos por el MISMO motivo de fondo, aunque
// pareciesen problemas distintos: los cazas volaban libres por el mundo y la cámara
// intentaba perseguirlos y encuadrarlos a posteriori. Con eso el encuadre es una
// apuesta, y se pierde:
//   1º de frente a 14-20 u/s → salían de cuadro antes de morir.
//   2º cámara que encuadra al grupo a 96 unidades → cazas de 21 píxeles.
//   3º cámara de persecución con sesgo 0.78 → la nave a NDC Y -0.96, cortada abajo.
//   4º dos senoides en ejes perpendiculares = la ecuación de una elipse → "dan
//      vueltas en círculos".
// Y el 5º, medido con capturas reales de la escena: a los 1.2s, 3s y 5s la nave NO
// estaba en cuadro. El techo de radio (21) evitaba que la cámara se alejara, pero la
// nave podía estar a más de 21 del foco, así que quedaba fuera de la esfera encuadrada.
//
// El cambio de fondo: los cazas ya NO vuelan por el mundo. Vuelan dentro del marco de
// referencia de la ruta —lateral, vertical y distancia por delante— siguiendo
// maniobras ESCRITAS. Como su posición se define respecto al mismo eje que mira la
// cámara, el encuadre deja de ser una apuesta y pasa a estar garantizado por
// construcción. Es lo que ya funcionó con el agujero negro: guionizarlo entero.
const COMBATE_BASE_T = 0.32;      // punto de la curva donde arranca la escena

// Marco de referencia de la escena, refrescado cada frame desde la curva.
const _cbP = new THREE.Vector3(), _cbF = new THREE.Vector3(),
      _cbR = new THREE.Vector3(), _cbU = new THREE.Vector3();
let combateAlabeo = 0;            // tonel de la nave; lo aplica el bucle de animación

// Maniobras. Cada caza es una función de u (0→1 de la cinemática) que devuelve su
// posición en el marco: `lat` a los lados, `ver` arriba/abajo, `ade` por delante de la
// nave. Los rangos están acotados a propósito —lat ±20, ver ±13, ade 15..42— porque
// son justo los que caben en el encuadre de la plataforma de cámara de abajo.
// Al ser funciones explícitas del tiempo, la trayectoria es repetible y se puede
// comprobar de antemano que nunca se sale; no hay integración que pueda derivar.
const MANIOBRAS = [
  { // 1) EL QUE CRUZA: entra por delante-derecha y barre hacia la izquierda ante el morro.
    muere: 0.30,
    f(u){
      const k = u/0.30;                                  // progreso dentro de su vida
      return { lat:  19 - 34*k,
               ver:   5 - 7*k + Math.sin(u*11)*1.4,
               ade:  38 - 17*k };
    }},
  { // 2) EL QUE SUBE: viene bajo por la izquierda, tira hacia arriba y pasa por encima.
    muere: 0.62,
    f(u){
      const k = Math.min(1, u/0.62);
      const s = k*k;                                     // acelera al final: es un tirón
      return { lat: -15 + 13*k + Math.sin(u*8.5)*2.2,
               ver:  -7 + 20*s,
               ade:  33 - 12*k };
    }},
  { // 3) EL QUE HUYE: quiebra a un lado y a otro intentando despegarse, y cae cerca.
    muere: 0.92,
    f(u){
      const k = Math.min(1, u/0.92);
      return { lat:  Math.sin(u*7.2)*15 + 4,             // quiebros amplios
               ver:   4 - 13*k + Math.sin(u*5.1)*2.5,
               ade:  30 - 12*k };
    }},
];

function prepararCombate(){
  if(!enemigoGeo) return;
  for(let i=0;i<MANIOBRAS.length;i++){
    const e = new THREE.Mesh(enemigoGeo, enemigoMat);
    // 3.2 y no 5.5: la nave del jugador mide 2.1 de lado mayor, así que a 5.5 los cazas
    // eran casi el triple que ella y la dejaban de mosca en su propia persecución.
    e.scale.setScalar(3.2);
    activarSombras(e);
    // Motor encendido en la cola: a distancia es lo que los distingue como naves.
    const motor = new THREE.Sprite(new THREE.SpriteMaterial({
      map:GLOW_TEX, color:0xff6a3a, transparent:true, opacity:0.75,
      blending:THREE.AdditiveBlending, depthWrite:false,
    }));
    // 0.7, no 2.2: con bloom el resplandor se hinchaba en un halo rosa que envolvía al
    // caza entero en los planos cortos; parecían globos. Ahora es un núcleo en la tobera.
    motor.scale.setScalar(0.7);
    // La geometría va normalizada a 1 en su lado MAYOR, que en este casco es la
    // envergadura (X). El largo (Z) es 0.78, así que la cola cae en z = +0.39.
    motor.position.set(0, 0, 0.39);     // +Z local = cola (el morro va en -Z)
    e.add(motor);
    scene.add(e);
    enemigos.push({
      malla:e, motor, plan:MANIOBRAS[i],
      pos: new THREE.Vector3(),
      prev: new THREE.Vector3(),       // para deducir el rumbo por diferencia
      tienePrev: false,
      muerto:false,
      tDisparo: 0.14 + i*0.22,         // en unidades de u: devuelven fuego antes de caer
      haDisparado:false,
    });
  }
}

// Fuego enemigo: pasa cerca de la cámara, no impacta. Reutiliza el pool de rayos.
function fuegoEnemigo(e){
  const b = bolts.find(x=>!x.activo);
  if(!b) return;
  b.origen.copy(e.pos);
  // Apunta a un punto desviado respecto a la nave, en el marco de la escena: fallan,
  // pero cruzan cerca del encuadre, que es lo que hace que se lean como amenaza.
  b.destino.copy(ship.position)
    .addScaledVector(_cbR, (Math.random()-0.5)*11)
    .addScaledVector(_cbU, (Math.random()-0.5)*7);
  b.dur = 0.34; b.t = 0; b.activo = true; b.rock = null;
  SND.disparo();
}

// `puntoRuta` y `tangenteRuta` llegan del bucle: son el punto y la tangente LIMPIOS de
// la curva, antes de que la nave se desplace persiguiendo. Tomar el marco de la ruta y
// no de la nave rompe la dependencia circular (la nave persigue a los cazas y los
// cazas se colocan respecto a la nave) que si no obligaría a ir un frame por detrás.
function actualizarCombate(u, dur, dt, puntoRuta, tangenteRuta){
  _cbP.copy(puntoRuta);
  _cbF.copy(tangenteRuta).normalize();
  _cbR.crossVectors(_cbF, UP).normalize();
  _cbU.crossVectors(_cbR, _cbF).normalize();

  // TONEL. Un giro completo sobre el eje de vuelo en la fase central, justo cuando el
  // caza que sube pasa por encima. Es el gesto que pedía la escena: sin él la nave se
  // limita a deslizarse mientras a su alrededor pasan cosas.
  // Fuera de la ventana vale 0; al acabar el giro completo 2π ≡ 0, así que volver a
  // cero no produce ningún salto visible.
  // Ventana alineada con el plano de la pasada (guiones.js, plano 6): el tonel se ve
  // con la nave viniendo de frente hacia una cámara fija, que es donde luce.
  const uR = (u - 0.47) / 0.13;
  combateAlabeo = (uR > 0 && uR < 1) ? Math.PI*2 * smoothstep01(uR) : 0;

  for(const e of enemigos){
    if(e.muerto) continue;
    const o = e.plan.f(u);
    e.prev.copy(e.pos);
    e.pos.copy(_cbP)
      .addScaledVector(_cbR, o.lat)
      .addScaledVector(_cbU, o.ver)
      .addScaledVector(_cbF, o.ade);
    e.malla.position.copy(e.pos);

    // Apunta HACIA DONDE VUELA, deducido del desplazamiento real de este frame. Así el
    // morro sigue la maniobra sin tener que derivar las funciones a mano.
    if(e.tienePrev){
      _cv1.subVectors(e.pos, e.prev);
      if(_cv1.lengthSq() > 1e-8){
        _lookTmp.copy(e.pos).add(_cv1);
        _mat4.lookAt(e.pos, _lookTmp, _cbU);
        e.malla.quaternion.setFromRotationMatrix(_mat4);
        e.malla.rotateY(Math.PI);                  // misma corrección de morro que la nave
        // Alabea hacia el interior del viraje, proporcional al desplazamiento lateral.
        e.malla.rotateZ(THREE.MathUtils.clamp(-_cv1.dot(_cbR) * 9, -1.1, 1.1));
      }
    }
    e.tienePrev = true;

    if(!e.haDisparado && u >= e.tDisparo){ e.haDisparado = true; fuegoEnemigo(e); }

    if(u >= e.plan.muere){
      e.muerto = true;
      const b = bolts.find(x=>!x.activo);
      if(b){
        _tmp.set(0,0,-1.6).applyQuaternion(ship.quaternion).add(ship.position);
        b.origen.copy(_tmp); b.destino.copy(e.pos);
        b.dur = 0.20; b.t = 0; b.activo = true; b.rock = null;
        SND.disparo();
      }
      // Mismas capas que al reventar una roca: núcleo, bola, onda y rescoldo. Un caza
      // no puede estallar con menos aparato que un pedrusco.
      destello(e.pos, { color:0xffffff, esc0:4.5, crece:34, dur:0.18, op:1 });
      destello(e.pos, { color:0xffa040, esc0:5,   crece:8,  dur:0.9,  op:0.95 });
      destello(e.pos, { tex:SHOCK_TEX, color:0xffd0a0, esc0:4, crece:34, dur:0.45, op:0.85 });
      destello(e.pos, { color:0xff5a1e, esc0:3.4, crece:3,  dur:1.6,  op:0.6 });
      emitirEscombros(e.pos, 4.2);
      SND.impacto();
      director.impacto(0.8);              // la explosión sacude la cámara
      scene.remove(e.malla);
    }
  }
}

// Lo que los planos del guion pueden consultar. Se crea una vez y lee el estado vivo.
const _centro = new THREE.Vector3();
const ctxCombate = {
  ship, F: _cbF, R: _cbR, U: _cbU,
  // Getters, no valores: _camA/_lookA se declaran más abajo (con el resto de temporales
  // del bucle) y leerlos aquí al definir el objeto rompería por la zona muerta temporal.
  get chasePos(){ return _camA; }, get chaseLook(){ return _lookA; },
  // Un caza muerto conserva su última posición: así el plano del derribo encuadra la
  // explosión aunque el modelo ya no esté.
  E: i => enemigos[i]?.pos ?? ship.position,
  centroCazas(){
    let n = 0; _centro.set(0,0,0);
    for(const e of enemigos) if(!e.muerto){ _centro.add(e.pos); n++; }
    return n ? _centro.divideScalar(n) : _centro.copy(ship.position);
  },
  // Disparos que pasan rozando la CÁMARA, no la nave: es lo que mete al espectador
  // dentro del tiroteo. Fallan a propósito por 1.5-3 unidades.
  disparoCercano(i){
    const e = enemigos[i]; if(!e || e.muerto) return;
    for(let n=0;n<3;n++){
      const b = bolts.find(x=>!x.activo); if(!b) return;
      b.origen.copy(e.pos);
      b.destino.copy(camera.position)
        .addScaledVector(_cbR, (n-1)*2.2 + (Math.random()-0.5))
        .addScaledVector(_cbU, 1.5 + Math.random())
        .addScaledVector(_cbF, -6);
      b.dur = 0.42 + n*0.09; b.t = -n*0.12; b.activo = true; b.rock = null;
    }
    SND.disparo();
  },
  sonido(n){ if(n === 'whoosh') SND.whoosh(0.8); },
};

function limpiarCombate(){
  for(const e of enemigos) if(!e.muerto) scene.remove(e.malla);
  enemigos.length = 0;
  combateAlabeo = 0;
}

// ── Poses de cámara de cada beat ──
const _cv1 = new THREE.Vector3(), _cv2 = new THREE.Vector3(), _cv3 = new THREE.Vector3();


// ── Beat 2: agujero negro, en cuatro fases ──
//   0.00–0.30  aproximación: plano amplio, la nave pequeña contra el disco
//   0.30–0.58  paso rasante: la gravedad tira de la nave, el disco llena el cuadro
//   0.58–0.72  caída: acelera hacia el horizonte y la pantalla se funde en blanco
//   0.72–1.00  salida: aparece MÁS ADELANTE en la ruta (el salto tipo agujero de gusano)
const AGUJERO_SALIDA_T = 0.63;    // t al que reaparece tras cruzar
let agujeroSaltado = false;

function posicionarNaveAgujero(u, ct){
  curve.getPointAt(Math.min(0.999, ct + 0.015), _p);
  curve.getTangentAt(Math.min(0.999, ct + 0.015), _tan).normalize();

  if(u < 0.72){
    // Arrastre progresivo hacia el agujero: cuadrático, así al principio apenas se
    // nota y al final es evidente que la gravedad manda más que los motores.
    const k = smoothstep01((u - 0.28) / 0.44);
    _cv1.subVectors(agujeroGrupo.position, _p);
    const distTotal = _cv1.length();
    _cv1.divideScalar(distTotal);
    // En la fase de caída se acerca de verdad al horizonte; antes sólo roza.
    const caida = u < 0.58 ? 0 : smoothstep01((u - 0.58) / 0.14);
    const acerca = Math.pow(k, 2.0) * (distTotal - AGUJERO_R*2.4) * 0.55
                 + caida * (distTotal - AGUJERO_R*1.15) * 0.62;
    ship.position.copy(_p).addScaledVector(_cv1, Math.min(acerca, distTotal - AGUJERO_R*1.05));
    // ── Orientación: perder el control de forma progresiva ──
    // Antes sólo barrenaba en la fase final y el resto del arrastre la nave viajaba
    // recta, así que no se leía que "tiraran" de ella. Ahora la orientación se
    // interpola de "morro hacia la ruta" a "morro hacia el agujero" según k, y encima
    // se le suma un tumbo creciente en los tres ejes: primero forcejea, después la
    // vuelca, y al final entra en barrena.
    _lookTmp.copy(ship.position).add(_tan);                  // hacia donde iba
    _mat4.lookAt(ship.position, _lookTmp, UP);
    _qA.setFromRotationMatrix(_mat4);
    _lookTmp.copy(ship.position).addScaledVector(_cv1, 10);  // hacia el agujero
    _mat4.lookAt(ship.position, _lookTmp, UP);
    _qB.setFromRotationMatrix(_mat4);
    // La nave se resiste al principio (por eso pow 1.4) y acaba cediendo del todo.
    ship.quaternion.copy(_qA).slerp(_qB, Math.pow(k, 1.4));

    const tumbo = k * (0.35 + caida*0.65);       // cuánto ha perdido el control
    const gt2 = u * 26;                          // reloj propio del tumbo
    ship.rotateY(Math.sin(gt2*0.73) * 0.55 * tumbo);
    ship.rotateX(Math.sin(gt2*0.51 + 1.3) * 0.45 * tumbo);
    // Barrena: giro continuo que acelera, más una oscilación encima
    ship.rotateZ(u * 9 * tumbo + Math.sin(gt2*1.17) * 0.7 * tumbo);
    if(shipOrientNode) shipOrientNode.visible = caida < 0.92;
  }else{
    // Ya ha salido por el otro lado: vuelve a la curva con normalidad.
    ship.position.copy(_p);
    _lookTmp.copy(_p).add(_tan);
    _mat4.lookAt(_p, _lookTmp, UP);
    ship.quaternion.setFromRotationMatrix(_mat4);
    if(shipOrientNode) shipOrientNode.visible = true;
  }
}

// Contexto que ven los planos del agujero. El marco apunta HACIA el agujero mientras
// éste arrastra la nave; tras el salto de gusano vuelve a la dirección de la ruta.
const _agF = new THREE.Vector3(), _agR = new THREE.Vector3(), _agU = new THREE.Vector3();
const ctxAgujero = {
  ship, F: _agF, R: _agR, U: _agU,
  get H(){ return agujeroGrupo.position; },
  get chasePos(){ return _camA; }, get chaseLook(){ return _lookA; },
  actualizar(u){
    if(u < 0.72) _agF.subVectors(agujeroGrupo.position, ship.position).normalize();
    else curve.getTangentAt(Math.min(0.999, progress + 0.015), _agF).normalize();
    _agR.crossVectors(_agF, UP).normalize();
    _agU.crossVectors(_agR, _agF).normalize();
  },
};

// ── Aterrizaje final ──
const finalPanel = document.getElementById('finalPanel');
function iniciarAterrizaje(){
  if(mode !== 'free') return;
  mode = 'landing'; landT = 0;
  SND.puerta();                      // el hangar de llegada abre al aproximarse
  speedHint.classList.add('hide');
  setActiveWaypoint(-1);             // fuera el panel de sección, llega el de contacto
  launchStatus.textContent = 'Aproximación final';
  launchStatus.classList.add('on');
}
function finAterrizaje(){
  mode = 'landed';
  progress = targetProgress = 1;     // el HUD marca 100% al posarse
  launchStatus.classList.remove('on');
  finalPanel.classList.add('on');
  SND.posado();
  SND.musicaVolumen(MUSIC_VOL * 0.55);  // la música baja un poco para el momento final
}

// Reinicio sin recargar: devuelve todo al estado de portada.
function reiniciarRecorrido(){
  mode = 'idle';
  director.end();
  escalaTiempo = 1;
  arrancado = false;                 // sin esto, el segundo recorrido no arrancaría
  launchT = landT = cineT = 0;
  cineIdx = -1;
  agujeroSaltado = false;
  limpiarCombate();
  destelloCine = 0;
  diveFlash.style.opacity = 0;
  if(shipOrientNode) shipOrientNode.visible = true;
  CINEMATICAS.forEach(c=> c.hecha = false);   // los beats vuelven a estar disponibles

  // Reiniciar los asteroides. Sin esto, en el segundo recorrido no se disparaba a
  // ninguna roca (seguían marcadas como disparadas) y las destruidas quedaban
  // invisibles para siempre, porque su matriz se había reescrito a escala 0.
  asteroidGroup.children.forEach(inst=>{
    inst.userData.rocks?.forEach(r=>{ r.disparado = false; r.muerto = false; });
  });
  // Cortar disparos, destellos y escombros que quedaran a medias.
  bolts.forEach(b=>{ b.activo = false; b.rock = null; });
  velIniciada = false;                // la nave vuelve al origen de un salto: sin esto
                                      // el roce de vuelo suena a fondo durante un frame
  ultimoDisparo = -99;                // si no, el primer derribo del nuevo recorrido
                                      // arrastraría el enfriamiento del anterior
  for(let i=flashes.length-1; i>=0; i--){
    scene.remove(flashes[i].sprite);
    flashes[i].sprite.material.dispose();
  }
  flashes.length = 0;
  escombrosP.forEach(e=> e.viva = false);
  humoP.forEach(h=> h.viva = false);
  progress = targetProgress = 0;
  lastZoneName = ''; lastCue = null; lastPct = -1;
  finalPanel.classList.remove('on');
  setActiveWaypoint(-1);
  startOverlay.style.display = '';
  tiPulsa.textContent = TEXTO_PULSA;
  aplicarResolucion(factorTitulo()); // la portada vuelve a verse en píxeles
  document.body.classList.add('en-portada');
  void startOverlay.offsetWidth;     // fuerza reflow: sin esto la transición no rearranca
  startOverlay.classList.remove('out');
  routeInput.reset();
  speedHint.classList.remove('hide');
}
// stopPropagation, igual que el botón de silencio: sin esto el click burbujea hasta
// el oyente global de `startExperience`, que se ejecuta en el MISMO evento — como
// reiniciarRecorrido acaba de poner arrancado=false, arrancaba de nuevo al instante y
// la portada no llegaba a verse.
document.getElementById('restartBtn').addEventListener('click', e=>{
  e.stopPropagation();
  reiniciarRecorrido();
});

// ── Entrada → progreso ──
// La rueda, el dedo y el teclado sólo pilotan en vuelo libre: durante portada,
// despegue, cinemáticas y aterrizaje manda la secuencia.
let targetProgress = 0, progress = 0;
const routeInput = createRouteInput({
  isEnabled: ()=> mode === 'free',
  onFirstMove: ()=> speedHint.classList.add('hide'),
});
const esTactil = matchMedia('(pointer: coarse)').matches;
// La pista dice lo que hay que hacer en ESTE dispositivo: "scroll" y "ratón" no
// significan nada en un móvil.
speedHint.textContent = esTactil
  ? 'Desliza hacia arriba para avanzar'
  : 'Rueda o flechas para avanzar · Mueve el ratón para pilotar';

// ── Parallax de ratón ──
// Se guarda el valor objetivo y se suaviza en el bucle: el valor crudo del evento
// da tirones cuando el ratón se mueve rápido.
// Sólo ratón. Antes también escuchaba el dedo, y como el dedo es el que avanza, cada
// deslizamiento hacía cabecear la cámara: era buena parte de lo "raro" en móvil. En
// táctil la cámara se mece sola (ver el bucle), que da vida al plano sin robar el gesto.
let mouseX = 0, mouseY = 0, mouseTX = 0, mouseTY = 0;
addEventListener('pointermove', e=>{
  if(e.pointerType !== 'mouse') return;
  mouseTX = (e.clientX/innerWidth  - 0.5) * 2;
  mouseTY = (e.clientY/innerHeight - 0.5) * 2;
});

const hudPct = document.getElementById('hudPct');
const progressFill = document.getElementById('progressFill');
const zoneLabelEl = document.getElementById('zoneLabel');
const diveFlash = document.getElementById('diveFlash');
let lastZoneName = '', lastPct = -1;
const clock = new THREE.Clock();
const perfPanel = document.getElementById('perfPanel');
// Arranca en -1 para que el panel se rellene ya en el primer frame en vez de quedarse
// en blanco el primer cuarto de segundo (la primera lectura de fps sale baja y se
// corrige sola al siguiente refresco).
let fpsDesde = -1, fpsMuestras = 0;
let whooshSonado = false, velSuave = 0, destelloCine = 0, velIniciada = false;
const _velPrev = new THREE.Vector3();

// ── Temporales reutilizados ──────────────────────────────────────────────────
// El bucle anterior creaba ~10 Vector3, un Matrix4 y un Color POR FRAME (más un
// Object3D por cada InstancedMesh). A 60fps eso es basura constante y el recolector
// acaba metiendo tirones. A partir de aquí el bucle no asigna nada.
const UP = new THREE.Vector3(0,1,0);
const UP_ALT = new THREE.Vector3(0,0,1);
// Plano final: tres cuartos delantero y algo elevado. La nave se posa con el morro
// hacia -Z, así que un offset con Z negativa deja la cámara delante de ella.
const HERO_OFFSET = new THREE.Vector3(9.5, 3.6, -12);
const _p=new THREE.Vector3(), _tan=new THREE.Vector3(), _tmp=new THREE.Vector3(), _lookTmp=new THREE.Vector3();
const _proj=new THREE.Vector3();   // proyección a viewport para decidir los disparos
const _cpP=new THREE.Vector3(), _cpT=new THREE.Vector3(), _cpR=new THREE.Vector3();
const _camA=new THREE.Vector3(), _camB=new THREE.Vector3();
const _lookA=new THREE.Vector3(), _lookB=new THREE.Vector3(), _look=new THREE.Vector3();
const _mat4=new THREE.Matrix4(), _qA=new THREE.Quaternion(), _qB=new THREE.Quaternion();
const _fogCol=new THREE.Color(), _dummy=new THREE.Object3D();

// (smoothK y smoothstep01 se declaran arriba del todo: los usa construirHangar,
//  que se ejecuta mucho antes que este bloque.)

// Pose de la chase-cam en un punto del recorrido. Se extrae a función porque el
// final del despegue necesita calcularla para interpolar hacia ella.
function chasePose(tt, dive, outPos, outLook, outShipPos, outShipTan){
  curve.getPointAt(Math.min(0.999, tt + 0.015), _cpP);   // la nave va por delante
  curve.getTangentAt(Math.min(0.999, tt + 0.015), _cpT).normalize();
  if(outShipPos) outShipPos.copy(_cpP);
  if(outShipTan) outShipTan.copy(_cpT);
  curve.getTangentAt(tt, _cpT).normalize();              // tangente de la cámara
  _cpR.crossVectors(_cpT, UP).normalize();
  outPos.copy(_cpP)
    .addScaledVector(_cpT, -4.4 - dive*2.0)
    .addScaledVector(UP,    1.5 - dive*2.6)
    .addScaledVector(_cpR,  mouseX*2.2)
    .addScaledVector(UP,   -mouseY*1.2);
  outLook.copy(_cpP).addScaledVector(_cpT, 2).addScaledVector(UP, 0.3 - dive*1.8);
}

// Perfil de aceleración del despegue: un tramo quieto con motores encendidos y luego
// arranque progresivo que FRENA al llegar a la ruta.
// Antes era pow(u, 1.75), que acelera hasta el último instante: la nave llegaba a la
// órbita a velocidad máxima y el relevo al scroll (que va lentísimo) era un frenazo
// seco. Con smootherstep la velocidad entra y sale suave — y su derivada es 0 en los
// dos extremos, así que no hay salto de velocidad ni al arrancar ni al acoplar.
function launchEase(x){
  const HOLD = 0.20;
  if(x <= HOLD) return 0;
  const u = (x - HOLD) / (1 - HOLD);
  return u*u*u*(u*(u*6 - 15) + 10);
}

// Cámara de la pantalla de título, relativa a la nave posada en la plataforma.
const TITULO_CAM = { radio: 7.5, altura: 1.4, angulo: 0.75, vaiven: 0.45, mira: 0.55 };

let paused = false;
document.addEventListener('visibilitychange', ()=>{
  paused = document.hidden;
  if(!paused) clock.getDelta();  // descarta el hueco acumulado con la pestaña oculta
});

// Escala de tiempo global: 1 = normal. Las cinemáticas la bajan para la cámara lenta
// (ver el director). Afecta a todo lo que se mueve —nave, partículas, disparos— pero no
// al audio, que va por su propio reloj.
let escalaTiempo = 1;
let apagadoCine = 0;        // 0 → 1 mientras hay cinemática (apaga halos de navegación)
// Tiempo de simulación: suma de los dt ESCALADOS. Las oscilaciones (balanceos, parpadeos)
// lo usan, así que en cámara lenta también van despacio, como debe ser.
let tiempoSim = 0;

function animate(){
  requestAnimationFrame(animate);
  if(paused) return;
  // Tope de dt: al volver de otra pestaña getDelta() devuelve segundos enteros y sin
  // recorte la nave pegaría un salto de decenas de unidades en un solo frame.
  const dtReal = Math.min(clock.getDelta(), 0.05);
  frame(dtReal);
}

// Un fotograma completo: simulación + dibujo. Separado de animate() para poder avanzarlo
// a mano con un dt fijo (herramienta de desarrollo de abajo).
function frame(dtReal){
  actualizarEnfoque(dtReal);
  // Rampa muy corta (~0.1 s): la cámara lenta debe entrar de golpe con el corte, pero
  // sin un escalón de un frame que se percibe como un tirón.
  escalaTiempo += ((director.activo ? director.escalaTiempo : 1) - escalaTiempo) * smoothK(0.35, dtReal);
  const dt = dtReal * escalaTiempo;
  tiempoSim += dt;
  const gt = tiempoSim;

  mouseX += (mouseTX - mouseX) * smoothK(0.12, dt);
  mouseY += (mouseTY - mouseY) * smoothK(0.12, dt);

  if(mode === 'free'){
    targetProgress += routeInput.consume(dt);
    if(targetProgress <= 0 || targetProgress >= 1){
      targetProgress = THREE.MathUtils.clamp(targetProgress, 0, 1);
      routeInput.stopMomentum();
    }
  }
  if(esTactil){
    // Vaivén lento en dos frecuencias no múltiplos: no se repite a la vista y deja la
    // cámara viva sin que nadie la toque.
    mouseTX = Math.sin(gt*0.31)*0.28 + Math.sin(gt*0.13)*0.12;
    mouseTY = Math.sin(gt*0.23)*0.16;
  }
  progress += (targetProgress - progress) * smoothK(0.08, dt);
  const tt = Math.min(0.999, progress);
  const dive = (mode === 'free') ? diveIntensity(tt) : 0;
  let thrust = 1;

  if(mode === 'cine'){
    // ── Momento guionizado ──
    const c = CINEMATICAS[cineIdx];
    cineT += dt;
    const u = Math.min(1, cineT / c.dur);
    progress += c.avance * dt;              // el recorrido sigue avanzando solo
    targetProgress = progress;
    const ct = Math.min(0.999, progress);

    if(c.nombre === 'agujero'){
      // EL SALTO: al cruzar el horizonte, el progreso da un brinco hacia adelante.
      // Es lo que convierte el paso rasante en un agujero de gusano con continuidad.
      if(!agujeroSaltado && u >= 0.72){
        agujeroSaltado = true;
        progress = targetProgress = AGUJERO_SALIDA_T;
        SND.whoosh(1);
      }
      posicionarNaveAgujero(u, Math.min(0.999, progress));
      // Fogonazo blanco: sube al caer, pico al cruzar, se apaga al salir.
      // Se guarda en una variable en vez de escribir el estilo aquí porque más abajo
      // el destello de la caída de la ruta escribe sobre el mismo elemento y lo
      // machacaba: el fogonazo se calculaba bien pero nunca llegaba a verse.
      destelloCine = u < 0.58 ? 0
        : (u < 0.72 ? smoothstep01((u-0.58)/0.14)
                    : 1 - smoothstep01((u-0.72)/0.16));
    }else{
      // La nave sigue la curva con normalidad; lo que cambia es la cámara.
      curve.getPointAt(Math.min(0.999, ct + 0.015), _p);
      curve.getTangentAt(Math.min(0.999, ct + 0.015), _tan).normalize();
      _lookTmp.copy(_p).add(_tan);
      _mat4.lookAt(_p, _lookTmp, UP);
      ship.position.copy(_p);

      // Los cazas se colocan ANTES de mover la nave, y a partir del punto y la
      // tangente LIMPIOS de la curva. De ahí salen los ejes de la escena (_cbF/_cbR/
      // _cbU) que usan tanto ellos como la cámara. Hacerlo en este orden es lo que
      // rompe la dependencia circular "la nave persigue a los cazas / los cazas se
      // colocan respecto a la nave", que antes obligaba a usar posiciones del frame
      // anterior y hacía que el encuadre fuese siempre un poco tarde.
      actualizarCombate(u, c.dur, dt, _p, _tan);

      // La nave PERSIGUE: se aparta del eje de la ruta hacia el caza vivo más cercano.
      // El desplazamiento va ACOTADO (±5.5 lateral, ±3 vertical) porque la plataforma
      // de cámara se ancla a la nave: si ésta pudiera irse lejos del eje, arrastraría
      // el encuadre y volveríamos al problema de siempre.
      let objetivo = null, mejorD = Infinity;
      for(const en of enemigos){
        if(en.muerto) continue;
        const dd = _p.distanceToSquared(en.pos);
        if(dd < mejorD){ mejorD = dd; objetivo = en.pos; }
      }
      let alabeo = Math.sin(gt*1.1)*0.10 + combateAlabeo;   // + el tonel guionizado
      if(objetivo){
        _cv1.subVectors(objetivo, _p);
        const lateral = _cv1.dot(_cbR), vertical = _cv1.dot(_cbU);
        ship.position
          .addScaledVector(_cbR, THREE.MathUtils.clamp(lateral*0.16, -5.5, 5.5))
          .addScaledVector(_cbU, THREE.MathUtils.clamp(vertical*0.12, -3.0, 3.0));
        alabeo += THREE.MathUtils.clamp(-lateral*0.045, -0.7, 0.7);
      }
      ship.quaternion.setFromRotationMatrix(_mat4);
      ship.rotateZ(alabeo);
    }

    // Entrada y salida mezcladas con la cámara normal: sin esto habría dos cortes
    // secos, uno al entrar y otro al salir.
    chasePose(Math.min(0.999, progress), 0, _camA, _lookA);
    if(c.nombre === 'agujero') ctxAgujero.actualizar(u);
    director.update(u, dtReal, c.nombre === 'agujero' ? ctxAgujero : ctxCombate);

    if(u >= 1){
      if(c.nombre === 'combate') limpiarCombate();
      else { destelloCine = 0; if(shipOrientNode) shipOrientNode.visible = true; }
      finCine();
    }

  } else if(mode === 'landing' || mode === 'landed'){
    // ── Aproximación y posado ──
    if(mode === 'landing') landT = Math.min(1, landT + dt/LANDING_DUR);
    const le = smoothstep01(landT);          // entra y sale suave: frena al posarse
    landingCurve.getPointAt(le, _p);
    landingCurve.getTangentAt(le, _tan).normalize();

    // Orientación: sigue la tangente durante la bajada y se NIVELA al final. Si no,
    // la nave se quedaría posada con el morro clavado hacia abajo (la tangente final
    // de la curva apunta a -0.32 en Y).
    _lookTmp.copy(_p).add(_tan);
    _mat4.lookAt(_p, _lookTmp, UP);
    _qA.setFromRotationMatrix(_mat4);
    _tmp.set(0, 0, -1);                       // morro al frente, nave a nivel
    _lookTmp.copy(_p).add(_tmp);
    _mat4.lookAt(_p, _lookTmp, UP);
    _qB.setFromRotationMatrix(_mat4);
    ship.position.copy(_p);
    ship.quaternion.copy(_qA).slerp(_qB, smoothstep01((landT - 0.62)/0.38));

    thrust = 1 - smoothstep01((landT - 0.5)/0.5);   // motores apagándose

    // Cámara: de la persecución a un plano fijo de la nave posada, con un poco de
    // parallax de ratón para que el plano final no quede muerto.
    chasePose(0.999, 0, _camA, _lookA);
    _camB.copy(_p).add(HERO_OFFSET);
    _camB.x += mouseX*1.8; _camB.y -= mouseY*1.0;
    // Se mira por DEBAJO del centro de la nave para que quede en la mitad alta del
    // encuadre y el panel de contacto no la tape.
    _lookB.copy(_p).addScaledVector(UP, -1.1);
    const wCam = smoothstep01((landT - 0.12)/0.88);
    camera.position.lerpVectors(_camA, _camB, wCam);
    _look.lerpVectors(_lookA, _lookB, wCam);
    camera.lookAt(_look);

    if(mode === 'landing' && landT >= 1) finAterrizaje();

  } else if(mode !== 'free'){
    // ── Portada y despegue ──
    if(mode === 'launch') launchT = Math.min(1, launchT + dt/LAUNCH_DUR);
    const le = launchEase(launchT);
    launchCurve.getPointAt(le, _p);
    launchCurve.getTangentAt(le, _tan).normalize();

    // Con la nave todavía vertical la tangente es paralela a UP y lookAt degenera
    // (los ejes se vuelven colineales → cuaternión basura). Se usa otro "arriba".
    _tmp.copy(Math.abs(_tan.dot(UP)) > 0.94 ? UP_ALT : UP);
    _lookTmp.copy(_p).add(_tan);
    _mat4.lookAt(_p, _lookTmp, _tmp);
    _qA.setFromRotationMatrix(_mat4);

    thrust = launchT < 0.03 ? 0 : Math.min(1, (launchT - 0.03)/0.13);
    const shake = launchT < 0.30 ? thrust * (1 - launchT/0.30) : 0;

    // Cámara: arranca baja y de costado mirando hacia arriba a la nave en la
    // plataforma, y se va colocando detrás hasta encajar con la chase-cam.
    // Offset inicial subido de -3.5 a -1.1 en Y: con el hangar puesto, la nave arranca
    // a y=-32.2 y el suelo está en -36, así que -3.5 dejaba la cámara enterrada en el
    // suelo. Ahora queda a ~2.7 del suelo, mirando la nave desde abajo.
    const e = smoothstep01((launchT - 0.12)/0.72);
    _camA.set(
      THREE.MathUtils.lerp(10.5, 0,   e),
      THREE.MathUtils.lerp(-1.1, 1.5, e),
      THREE.MathUtils.lerp(11.0, 4.4, e)
    ).add(_p);
    _lookA.copy(_p);
    if(mode === 'idle'){
      // Pose PROPIA de la portada: más alta que la del despegue (allí el borde de la
      // plataforma tapaba la nave) y meciéndose despacio a su alrededor, el "modo demo"
      // de las pantallas de título. El salto a la pose del despegue ocurre bajo el
      // fundido a negro de la intro, así que no se ve.
      const a = TITULO_CAM.angulo + Math.sin(gt*0.16) * TITULO_CAM.vaiven;
      _camA.set(Math.sin(a)*TITULO_CAM.radio, TITULO_CAM.altura, Math.cos(a)*TITULO_CAM.radio).add(_p);
      _lookA.copy(_p).addScaledVector(UP, TITULO_CAM.mira);
    }

    // Relevo hacia la pose de scroll. Ventana ampliada del último 22% al último 42%
    // (de 1.5s a casi 3s): posición, punto de mira y orientación se mezclan a la vez
    // y con más recorrido, así el acoplamiento se siente progresivo y no un corte.
    chasePose(0, 0, _camB, _lookB);
    const w = smoothstep01((launchT - 0.58)/0.42);
    camera.position.lerpVectors(_camA, _camB, w);
    _look.lerpVectors(_lookA, _lookB, w);

    ship.position.copy(_p);
    curve.getTangentAt(0.015, _tmp).normalize();
    _lookTmp.copy(_p).add(_tmp);
    _mat4.lookAt(_p, _lookTmp, UP);
    _qB.setFromRotationMatrix(_mat4);
    ship.quaternion.copy(_qA).slerp(_qB, w);

    // Traqueteo: suma de senos a frecuencias distintas, no ruido blanco. Con
    // Math.random() por frame la imagen daba saltos incoherentes de ±0.45 unidades y
    // se leía como un fallo de render, no como motores rugiendo. Ahora es continuo,
    // de amplitud menor, y arrastra también el punto de mira para que la vista
    // vibre entera en vez de teletransportarse.
    if(shake > 0.001){
      const rx = (Math.sin(gt*47.0) + Math.sin(gt*31.3)*0.6) * 0.10 * shake;
      const ry = (Math.sin(gt*53.7) + Math.sin(gt*37.1)*0.6) * 0.10 * shake;
      camera.position.x += rx; camera.position.y += ry;
      _look.x += rx*0.35;      _look.y += ry*0.35;
      camera.lookAt(_look);
      camera.rotateZ(Math.sin(gt*29.0)*0.007*shake);   // balanceo mínimo, da peso
    } else {
      camera.lookAt(_look);
    }
    rumbleEl.style.opacity = thrust * (1 - smoothstep01((launchT-0.30)/0.40)) * 0.4;

    if(mode === 'launch'){
      for(let i=LAUNCH_CUES.length-1; i>=0; i--){
        if(launchT >= LAUNCH_CUES[i][0]){
          if(lastCue !== LAUNCH_CUES[i][1]){ lastCue = LAUNCH_CUES[i][1]; launchStatus.textContent = lastCue; }
          break;
        }
      }
      if(launchT >= 1) finishLaunch();
    }

  } else {
    // ── Recorrido controlado por scroll ──
    chasePose(tt, dive, _camA, _look, _p, _tan);
    camera.position.copy(_camA);

    _lookTmp.copy(_p).add(_tan);
    _mat4.lookAt(_p, _lookTmp, UP);
    ship.position.copy(_p);
    ship.quaternion.setFromRotationMatrix(_mat4);
    ship.rotateX(dive * 0.9);                              // morro abajo en la caída
    ship.rotateZ(Math.sin(gt*2.2)*0.04 - mouseX*0.22);     // balanceo + alabeo al pilotar

    // Mismo criterio que en el despegue: sacudida continua, no ruido blanco por frame.
    if(dive > 0.05){
      const rx = (Math.sin(gt*41.0) + Math.sin(gt*27.7)*0.6) * 0.13 * dive;
      const ry = (Math.sin(gt*49.3) + Math.sin(gt*33.9)*0.6) * 0.13 * dive;
      camera.position.x += rx; camera.position.y += ry;
      _look.x += rx*0.4;       _look.y += ry*0.4;
      camera.lookAt(_look);
      camera.rotateZ(Math.sin(gt*23.0)*0.012*dive);
    } else {
      camera.lookAt(_look);
    }

    // Momentos guionizados: se disparan al alcanzar su punto y sólo una vez.
    for(let i=0;i<CINEMATICAS.length;i++){
      if(!CINEMATICAS[i].hecha && tt >= CINEMATICAS[i].t){ iniciarCine(i); break; }
    }

    // Al llegar al final del recorrido arranca la secuencia de aterrizaje.
    if(progress >= LANDING_TRIGGER) iniciarAterrizaje();
  }

  // La luz direccional y su objetivo persiguen a la nave, así que la cámara de sombra
  // (26 unidades de lado) siempre encuadra lo que hay alrededor. Una sola cámara fija
  // que cubriera la ruta entera daría ~6 texels por unidad: papilla.
  if(Q.sombras){
    sun.position.copy(ship.position).addScaledVector(SUN_DIR, 60);
    sun.target.position.copy(ship.position);
    sun.target.updateMatrixWorld();
  }

  // ── Sonido ──
  // Roce de vuelo según la velocidad REAL de la nave en el mundo (no el scroll), así
  // sube en los tramos rápidos de la curva aunque muevas la rueda igual.
  // En el primer frame _velPrev está en el origen y la nave en la plataforma: sin este
  // arranque, la "velocidad" sería de ~124 unidades y sonaría el roce de vuelo con la
  // nave completamente parada.
  if(!velIniciada){ _velPrev.copy(ship.position); velIniciada = true; }
  const velNave = _velPrev.distanceTo(ship.position) / Math.max(dt, 1e-4);
  _velPrev.copy(ship.position);
  velSuave += (Math.min(1, velNave/70) - velSuave) * smoothK(0.06, dt);
  SND.vuelo(velSuave);
  // Un único whoosh al entrar en la caída, no uno por frame.
  if(dive > 0.12 && !whooshSonado){ whooshSonado = true; SND.whoosh(0.6); }
  else if(dive < 0.04) whooshSonado = false;

  // FOV: sólo se recalcula la matriz de proyección si cambia de verdad.
  // En cinemática la lente la pone el plano (el director ya la ha aplicado).
  const targetFov = director.activo ? director.fov
    : BASE_FOV + dive*20 + (mode==='launch' ? thrust*7 : 0);
  if(Math.abs(camera.fov - targetFov) > 0.02){
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
  // El mayor de los dos: el de la caída de la ruta y el de la cinemática del agujero.
  diveFlash.style.opacity = Math.max(Math.max(0, dive - 0.6) * 1.2, destelloCine);

  // ── Motor de la nave: núcleo pequeño + estela ──
  if(engineFlare){
    const s = (0.42 + thrust*0.48) * (0.9 + Math.sin(gt*26)*0.1);
    engineFlare.scale.set(s, s, 1);
    engineFlare.material.opacity = 0.25 + thrust*0.6;
  }
  if(engineLight) engineLight.intensity = 0.5 + thrust*2.8;

  // Historial de la tobera a paso fijo. Si se añadiese una muestra por frame, la
  // estela mediría la mitad a 144Hz que a 60Hz.
  _tmp.set(0, 0.05, 1.2).applyQuaternion(ship.quaternion).add(ship.position);
  if(!trailReady){ for(let i=0;i<TRAIL_LEN;i++) trailPts[i].copy(_tmp); trailReady = true; }
  trailAccum += dt;
  // Si en un frame toca avanzar varias casillas, las intermedias se rellenan
  // interpolando entre la cabeza anterior y la posición actual. Sin esto conservaban la
  // posición de hace TRAIL_LEN muestras y aparecían puntos sueltos lejos de la nave.
  _trailPrev.copy(trailPts[trailHead]);
  const cabezaAnt = trailHead;
  let pasos = 0;
  while(trailAccum >= TRAIL_STEP && pasos < 8){
    trailAccum -= TRAIL_STEP;
    trailHead = (trailHead + 1) % TRAIL_LEN;
    pasos++;
  }
  for(let k=1;k<pasos;k++) trailPts[(cabezaAnt + k) % TRAIL_LEN].lerpVectors(_trailPrev, _tmp, k/pasos);
  trailPts[trailHead].copy(_tmp);   // la cabeza sigue siempre a la nave, avance o no
  for(let i=0;i<TRAIL_LEN;i++){
    const q = trailPts[(trailHead - i + TRAIL_LEN) % TRAIL_LEN];
    trailPosArr[i*3] = q.x; trailPosArr[i*3+1] = q.y; trailPosArr[i*3+2] = q.z;
    // Cada punto mide al menos lo que lo separa del siguiente: a cualquier velocidad se
    // solapan y la estela se lee como un penacho continuo, no como una ristra de cuentas
    // (pasaba en las cinemáticas, con la nave arrastrada muy rápido y vista de lado).
    if(i > 0){
      const p = trailPts[(trailHead - i + 1 + TRAIL_LEN) % TRAIL_LEN];
      trailSize[i] = Math.max(trailSizeBase[i], Math.min(q.distanceTo(p) * 1.15, 1.2));
    }
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.aSize.needsUpdate = true;
  trailMat.uniforms.uThrust.value = thrust * (1 + dive*0.6);
  const escalaPx = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  trailMat.uniforms.uScale.value = escalaPx;
  trailMat.uniforms.uMaxPx.value = renderer.domElement.height * 0.07;
  humoMat.uniforms.uScale.value  = escalaPx;
  escMat.uniforms.uScale.value   = escalaPx;   // faltaba: los escombros se quedaban
                                               // con el 600 por defecto, así que su
                                               // tamaño no seguía ni al FOV ni al DPR

  // ── Humo ──
  // Sólo se emite durante el despegue y mientras la nave sigue cerca del hangar:
  // fuera no tendría sentido físico y sería gasto tirado.
  if(mode === 'launch' && thrust > 0.05 && ship.position.z > HANGAR.boca - 12){
    humoAcum += dt;
    const porSegundo = 90 * thrust;
    while(humoAcum > 1/porSegundo){
      humoAcum -= 1/porSegundo;
      emitirHumo(_tmp, 1);   // _tmp sigue siendo la posición de la tobera
    }
  }
  {
    let vivas = 0;
    for(let i=0;i<SMOKE_MAX;i++){
      const h = humoP[i];
      if(h.viva){
        h.vida += dt;
        if(h.vida >= h.maxVida) h.viva = false;
        else {
          h.pos.addScaledVector(h.vel, dt);
          // Al alcanzar el suelo del hangar, la columna se aplasta y se expande en
          // horizontal, que es lo que da la lectura de "humo de lanzamiento".
          if(h.pos.y <= HANGAR.suelo + 0.4){
            h.pos.y = HANGAR.suelo + 0.4;
            h.vel.y = 0;
            h.vel.x *= 1 + dt*2.6;
            h.vel.z *= 1 + dt*2.6;
          }
          h.vel.multiplyScalar(1 - dt*0.55);   // rozamiento: se va parando
        }
      }
      const u = h.viva ? h.vida/h.maxVida : 1;
      humoPos[i*3] = h.pos.x; humoPos[i*3+1] = h.pos.y; humoPos[i*3+2] = h.pos.z;
      // Más gordo y más opaco que el primer intento: con los valores anteriores el
      // humo existía (se medían 90-220 partículas vivas) pero era tan tenue y pequeño
      // que no se distinguía del fondo.
      humoSize[i] = h.viva ? h.tam * (1 + u*4.5) : 0;   // se hincha al envejecer
      humoFade[i] = h.viva ? Math.sin(Math.min(1,u*1.15) * Math.PI) * 1.5 : 0;
      if(h.viva) vivas++;
    }
    // Se suben los búferes mientras quede humo vivo, más UN frame extra para que la
    // última partícula se apague en pantalla. Fuera de eso no se toca la GPU.
    if(vivas > 0 || humoHabia){
      humoGeo.attributes.position.needsUpdate = true;
      humoGeo.attributes.aSize.needsUpdate = true;
      humoGeo.attributes.aFade.needsUpdate = true;
    }
    humoHabia = vivas > 0;
  }

  // ── Estrellas ──
  // El campo lejano se ancla a la cámara (cielo "infinito"). Antes estaba fijo en el
  // origen y la última mitad de la ruta se recorría con el cielo casi vacío delante.
  starsFar.position.copy(camera.position);
  starsFar.material.size  = 1.1 + dive*2.2;
  starsNear.material.size = 2.0 + dive*2.5;

  // ── Polvo: se envuelve en una caja que sigue a la cámara ──
  for(let i=0;i<DUST_COUNT;i++){
    const i3 = i*3;
    while(dustPos[i3]   - camera.position.x >  DUST_HALF) dustPos[i3]   -= DUST_BOX;
    while(dustPos[i3]   - camera.position.x < -DUST_HALF) dustPos[i3]   += DUST_BOX;
    while(dustPos[i3+1] - camera.position.y >  DUST_HALF) dustPos[i3+1] -= DUST_BOX;
    while(dustPos[i3+1] - camera.position.y < -DUST_HALF) dustPos[i3+1] += DUST_BOX;
    while(dustPos[i3+2] - camera.position.z >  DUST_HALF) dustPos[i3+2] -= DUST_BOX;
    while(dustPos[i3+2] - camera.position.z < -DUST_HALF) dustPos[i3+2] += DUST_BOX;
  }
  dustGeo.attributes.position.needsUpdate = true;

  // ── Estrellas fugaces ──
  for(let i=0;i<SHOOTER_COUNT;i++){
    const s = shooters[i], i6 = i*6;
    if(!s.active){
      s.delay -= dt;
      if(s.delay <= 0) spawnShooter(s, camera.position);
    }else{
      s.life += dt;
      if(s.life >= s.maxLife){ s.active = false; s.delay = 1.2 + Math.random()*7; }
      else s.pos.addScaledVector(s.vel, dt);
    }
    if(s.active){
      _tmp.copy(s.vel).normalize();
      shooterPos[i6]   = s.pos.x;               shooterPos[i6+1] = s.pos.y;               shooterPos[i6+2] = s.pos.z;
      shooterPos[i6+3] = s.pos.x - _tmp.x*s.len; shooterPos[i6+4] = s.pos.y - _tmp.y*s.len; shooterPos[i6+5] = s.pos.z - _tmp.z*s.len;
      // Entra y sale con un fundido en campana; la cola en negro = degradado.
      const fade = Math.sin((s.life/s.maxLife) * Math.PI);
      shooterCol[i6] = s.col.r*fade; shooterCol[i6+1] = s.col.g*fade; shooterCol[i6+2] = s.col.b*fade;
      shooterCol[i6+3] = 0; shooterCol[i6+4] = 0; shooterCol[i6+5] = 0;
    }else{
      // Segmento degenerado a un punto: invisible sin tocar el draw range.
      for(let k=0;k<6;k++){ shooterPos[i6+k] = 0; shooterCol[i6+k] = 0; }
    }
  }
  shooterGeo.attributes.position.needsUpdate = true;
  shooterGeo.attributes.color.needsUpdate = true;

  // ── Tráfico de naves ──
  if(trafficMesh){
    for(let i=0;i<traffic.length;i++){
      const s = traffic[i];
      s.u += dt * s.speed;
      if(s.u > 1) s.u -= 1;
      s.pos.copy(s.anchor).add(s.offset).addScaledVector(s.dir, (s.u - 0.5) * s.span);
      _lookTmp.copy(s.pos).add(s.dir);
      _mat4.lookAt(s.pos, _lookTmp, UP);
      _dummy.position.copy(s.pos);
      _dummy.quaternion.setFromRotationMatrix(_mat4);
      _dummy.rotateY(Math.PI);            // misma corrección de morro que la protagonista
      _dummy.scale.setScalar(s.scale);
      _dummy.updateMatrix();
      trafficMesh.setMatrixAt(i, _dummy.matrix);
      _tmp.copy(s.pos).addScaledVector(s.dir, -s.scale*0.55);   // motor, en la cola
      trafficGlowPos[i*3] = _tmp.x; trafficGlowPos[i*3+1] = _tmp.y; trafficGlowPos[i*3+2] = _tmp.z;
    }
    trafficMesh.instanceMatrix.needsUpdate = true;
    trafficGlowGeo.attributes.position.needsUpdate = true;
  }

  // ── Zona actual → niebla + etiqueta ──
  const zone = zoneAt(tt);
  _fogCol.setHex(zone.fog);
  scene.fog.color.lerp(_fogCol, smoothK(0.04, dt));
  scene.fog.density += (zone.density - scene.fog.density) * smoothK(0.04, dt);
  // Cuanto más densa la zona, menos estrellas se ven: 0.9 en espacio abierto (0.010),
  // ~0.3 en la entrada atmosférica (0.030). Es lo que hace creíble que el cielo se aclare.
  starsFar.material.opacity = starsNear.material.opacity =
    0.9 * THREE.MathUtils.clamp(1 - (scene.fog.density - 0.010) / 0.030, 0.25, 1);
  if(zone.name !== lastZoneName && mode === 'free'){
    zoneLabelEl.textContent = zone.name; lastZoneName = zone.name;
  }

  // ── Asteroides ──
  // Sólo se reescriben las matrices de instancia con el campo cerca: son ~78 matrices
  // por frame y desde el otro extremo de la ruta no se aprecia ni una.
  // El disparo se decide por geometría (¿está la roca delante y en cuadro?), no por
  // el progreso en la curva: ver DISPARO_DIST / DISPARO_COS arriba.
  if(tt > 0.06 && tt < 0.46){
    // Camera.updateMatrixWorld() también recalcula matrixWorldInverse, que es la que
    // necesita project(). Sin esto se proyectaría con la matriz del frame anterior.
    camera.updateMatrixWorld();
    // Un solo disparo por frame y como mucho uno cada DISPARO_PAUSA segundos. Se
    // comprueba aquí arriba, fuera del bucle, para no pagar la proyección de cada roca
    // cuando el cañón todavía está en enfriamiento.
    let puedeDisparar = (gt - ultimoDisparo) >= DISPARO_PAUSA;
    for(let k=0;k<asteroidGroup.children.length;k++){
      const inst = asteroidGroup.children[k], rocks = inst.userData.rocks;
      if(!rocks) continue;
      for(let i=0;i<rocks.length;i++){
        const r = rocks[i];
        if(puedeDisparar && mode === 'free' && r.objetivo && !r.disparado && !r.muerto &&
           ship.position.distanceToSquared(r.pos) < DISPARO_DIST*DISPARO_DIST){
          // ¿Cae dentro del encuadre AHORA? project() usa matrixWorldInverse, que sólo
          // se recalcula al renderizar, así que hay que actualizarla antes (ver arriba).
          // NUNCA se dispara a algo que no esté en cuadro. Hubo un parche que permitía
          // disparar "por cercanía" aunque la roca estuviera fuera de cámara, y el
          // resultado era exactamente eso: disparos a la nada. Si una roca no llega a
          // verse, sencillamente no se le dispara; ya está a distancia de seguridad.
          _proj.copy(r.pos).project(camera);
          if(_proj.z < 1 && Math.abs(_proj.x) < DISPARO_NDC && Math.abs(_proj.y) < DISPARO_NDC){
            if(dispararA(r)){ ultimoDisparo = gt; puedeDisparar = false; }
          }
        }
        _dummy.position.copy(r.pos);
        _dummy.rotation.set(gt*r.spin + r.phase, gt*r.spin*0.7, r.tilt);
        _dummy.scale.setScalar(r.muerto ? 0 : r.scale);   // reventada = invisible
        _dummy.updateMatrix();
        inst.setMatrixAt(i, _dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
  }

  // ── Disparos, destellos e impactos ──
  for(let i=0;i<BOLT_MAX;i++){
    const b = bolts[i], base = i*BOLT_PTS;
    if(b.activo){
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      _p.lerpVectors(b.origen, b.destino, u);
      _tan.subVectors(b.destino, b.origen).normalize();
      for(let k=0;k<BOLT_PTS;k++){
        const idx = base + k, sep = k*1.5;           // cabeza y estela por detrás
        boltPos[idx*3]   = _p.x - _tan.x*sep;
        boltPos[idx*3+1] = _p.y - _tan.y*sep;
        boltPos[idx*3+2] = _p.z - _tan.z*sep;
        // 2.6 unidades de mundo, no 0.85: medido, con 0.85 el rayo ocupaba el 0.1% de
        // la pantalla durante 0.15s, o sea invisible. Es lo que hacía que "no se
        // vieran los disparos" aunque la lógica funcionase.
        boltSize[idx] = 2.6 * (1 - k*0.13);
        boltFade[idx] = 1 - k*0.15;
      }
      // b.rock es null en los rayos del combate: ahí la explosión la gestiona la
      // propia cinemática, no hay roca que reventar.
      if(u >= 1){ b.activo = false; if(b.rock) explotarRoca(b.rock); }
    }else{
      for(let k=0;k<BOLT_PTS;k++){ const idx = base + k; boltSize[idx] = 0; boltFade[idx] = 0; }
    }
  }
  boltGeo.attributes.position.needsUpdate = true;
  boltGeo.attributes.aSize.needsUpdate = true;
  boltGeo.attributes.aFade.needsUpdate = true;
  boltMat.uniforms.uScale.value = escalaPx;

  for(let i=flashes.length-1; i>=0; i--){
    const fl = flashes[i];
    fl.vida += dt;
    const u = fl.vida / fl.dur;
    if(u >= 1){
      scene.remove(fl.sprite);
      fl.sprite.material.dispose();
      flashes.splice(i, 1);
      continue;
    }
    // Se apaga con curva cuadrática, no lineal: así el destello aguanta brillante casi
    // todo su tiempo de vida y luego cae de golpe, en vez de irse desvaneciendo desde
    // el primer frame (que es lo que lo hacía parecer flojo).
    fl.sprite.material.opacity = (fl.op ?? 0.9) * (1 - u) * (1 - u*0.55);
    fl.sprite.scale.setScalar(fl.sprite.scale.x + dt*(fl.crece ?? 7));
  }

  {
    let vivas = 0;
    for(let i=0;i<ESCOMBROS_MAX;i++){
      const e = escombrosP[i];
      if(e.viva){
        e.vida += dt;
        if(e.vida >= e.maxVida) e.viva = false;
        else{ e.pos.addScaledVector(e.vel, dt); e.vel.multiplyScalar(1 - dt*1.6); }
      }
      const u = e.viva ? e.vida/e.maxVida : 1;
      escPos[i*3] = e.pos.x; escPos[i*3+1] = e.pos.y; escPos[i*3+2] = e.pos.z;
      escSize[i] = e.viva ? e.tam * (1 - u*0.3) : 0;
      escFade[i] = e.viva ? Math.sin(Math.min(1,u*1.2) * Math.PI) * 0.85 : 0;
      if(e.viva) vivas++;
    }
    if(vivas > 0 || escombrosHabia){
      escGeo.attributes.position.needsUpdate = true;
      escGeo.attributes.aSize.needsUpdate = true;
      escGeo.attributes.aFade.needsUpdate = true;
    }
    escombrosHabia = vivas > 0;
  }

  // ── Agujero negro ──
  // Sólo se anima cuando está a tiro: fuera de su tramo son 700 puntos de cálculo
  // por frame para algo que la niebla y la distancia ya han dejado atrás.
  // Fundido en los bordes de la ventana: como lleva fog:false, sin esto aparecería
  // y desaparecería de golpe en mitad del vacío.
  // La ventana llega hasta 0.72 porque la cinemática salta a t=0.63 y el agujero
  // tiene que seguir visible justo después de salir por el otro lado.
  const opAgujero = Math.min(
    smoothstep01((tt - 0.20) / 0.07),
    1 - smoothstep01((tt - 0.72) / 0.06)
  );
  if(opAgujero > 0.001){
    agujeroDisco.material.uniforms.uTime.value = gt;
    agujeroDisco.material.uniforms.uOpacidad.value = opAgujero;
    agujeroFotones.material.opacity = 0.85 * opAgujero;
    agujeroPolvo.material.opacity = 0.9 * opAgujero;
    const arr = agujeroPolvo.geometry.attributes.position.array;
    for(let i=0;i<agujeroPolvoDat.length;i++){
      const d = agujeroPolvoDat[i];
      // Rotación diferencial: cuanto más cerca del horizonte, más rápido gira.
      d.a += dt * d.vel * (AGUJERO_R*2.2 / Math.max(d.r, AGUJERO_R));
      d.r -= dt * d.vel * 1.6;
      if(d.r <= AGUJERO_R*1.02){          // cruzó el horizonte: reaparece fuera
        d.r = AGUJERO_R*2.6 + Math.random()*AGUJERO_R*0.9;
        d.a = Math.random()*Math.PI*2;
        d.y = (Math.random()-0.5)*3.5;
      }
      // El disco está en el plano XY local del grupo (RingGeometry), así que Z es el
      // grosor. Se aplana según cae, como la materia real al espiralar hacia dentro.
      arr[i*3]   = Math.cos(d.a)*d.r;
      arr[i*3+1] = Math.sin(d.a)*d.r;
      arr[i*3+2] = d.y * (d.r/(AGUJERO_R*3));
    }
    agujeroPolvo.geometry.attributes.position.needsUpdate = true;
    agujeroGrupo.visible = true;
  } else {
    agujeroGrupo.visible = false;
  }

  // ── Restos de batalla ──
  // Sólo giran cuando estás cerca: son ~25 matrices por frame y desde el otro extremo
  // de la ruta no se distingue ni una. Mismo criterio que el campo de asteroides.
  const restosCerca = tt > RESTOS_T - 0.14 && tt < RESTOS_T + 0.16;
  if(restosCerca){
    for(const campo of restosCampos){
      for(let i=0;i<campo.dat.length;i++){
        const r = campo.dat[i];
        _dummy.position.copy(r.pos);
        _dummy.rotation.set(r.fase.x + gt*r.giro.x, r.fase.y + gt*r.giro.y, r.fase.z + gt*r.giro.z);
        _dummy.scale.setScalar(r.esc);
        _dummy.updateMatrix();
        campo.inst.setMatrixAt(i, _dummy.matrix);
      }
      campo.inst.instanceMatrix.needsUpdate = true;
    }
    restosGrupo.visible = true;
  }else{
    restosGrupo.visible = false;
  }

  // Astronauta a la deriva: gira sin control. Sólo se anima cerca de la estación.
  if(astronauta && tt > 0.70 && tt < 0.95){
    const gA = astronauta.userData.giro;
    astronauta.rotation.set(gt*gA.x, gt*gA.y, gt*gA.z);
    astronauta.visible = true;
  }else if(astronauta){
    astronauta.visible = false;
  }

  nebulaGroup.rotation.y += dt*0.02;   // ahora sí gira sobre su centro

  for(let i=0;i<stationGroup.children.length;i++){
    const c = stationGroup.children[i];
    if(c.userData.blink !== undefined){
      c.material.opacity = 0.35 + Math.sin(gt*3 + c.userData.blink)*0.35;
    }else if(c.userData.drift){
      const d = c.userData.drift;
      c.position.y = d.y + Math.sin(gt*0.35 + d.phase)*d.amp;
      c.rotation.z = Math.sin(gt*0.22 + d.phase)*0.05;
    }
  }

  // Los dos hangares están a ~420 unidades uno del otro y la niebla no deja ver más
  // de ~100, así que dibujar el lejano es gasto puro: el frustum no lo descarta porque
  // sí cae en la dirección de vista, sólo que invisible tras la niebla.
  const verSalida  = camera.position.distanceToSquared(BOCA_SALIDA)  < 260*260;
  const verLlegada = camera.position.distanceToSquared(BOCA_LLEGADA) < 260*260;
  hangarSalida.grupo.visible  = padGroup.visible  = verSalida;
  hangarLlegada.grupo.visible = landGroup.visible = verLlegada;

  // ── Puertas de los hangares ──
  // Salida: cerradas en portada, abren durante la ignición y quedan abiertas de par en
  // par mucho antes de que la nave llegue a la boca (cruza en launchT=0.60).
  // Llegada: cerradas hasta que la nave se aproxima; abren durante el primer tercio
  // del descenso, así la maniobra "pide pista" en vez de aparecer con todo abierto.
  hangarSalida.setApertura(mode === 'idle' ? 0 : (mode === 'launch' ? (launchT - 0.06)/0.26 : 1));
  hangarLlegada.setApertura(mode === 'landing' || mode === 'landed' ? (landT - 0.05)/0.30 : 0);

  const parpadeo = (arr, ritmo)=>{
    for(let i=0;i<arr.length;i++)
      arr[i].material.opacity = 0.3 + Math.sin(gt*ritmo + arr[i].userData.phase)*0.4;
  };
  parpadeo(hangarSalida.balizas,  mode === 'launch' ? 8 : 1.6);
  parpadeo(hangarLlegada.balizas, mode === 'landing' ? 8 : 1.6);

  // Luces de las dos plataformas. La de salida late deprisa durante la ignición; la de
  // llegada se acelera cuando la nave está entrando, como una baliza de aproximación.
  const ritmoSalida  = (mode === 'idle') ? 2.2 : (mode === 'launch' ? 9 : 1.2);
  const ritmoLlegada = (mode === 'landing') ? 7 : (mode === 'landed' ? 1.0 : 2.0);
  for(let i=0;i<padLights.length;i++)
    padLights[i].material.opacity = 0.35 + Math.sin(gt*ritmoSalida + padLights[i].userData.phase)*0.35;
  for(let i=0;i<landLights.length;i++)
    landLights[i].material.opacity = 0.35 + Math.sin(gt*ritmoLlegada + landLights[i].userData.phase)*0.35;

  // ── Waypoints ──
  let closest = -1, closestDist = 0.045;
  for(let i=0;i<WAYPOINTS.length;i++){
    const d = Math.abs(WAYPOINTS[i].t - tt);
    if(d < closestDist){ closestDist = d; closest = i; }
  }
  setActiveWaypoint(mode === 'free' ? closest : -1);

  // Los halos y anillos de los planetas-sección son señales de navegación pensadas para la
  // cámara de vuelo. Vistos desde las cámaras laterales de una cinemática se convertían en
  // arcos turquesa gigantes cruzando el plano: se apagan mientras dura la escena.
  apagadoCine += ((director.activo ? 1 : 0) - apagadoCine) * smoothK(0.3, dtReal);
  for(let i=0;i<waypointPlanets.length;i++){
    const pl = waypointPlanets[i];
    pl.ring.material.opacity = 0.2 * (1 - apagadoCine);
    pl.halo.visible = pl.ring.visible = apagadoCine < 0.99;
    pl.mesh.rotation.y += dt*pl.spin;
    pl.ring.rotation.z += dt*pl.spin*0.4;
    // El halo respira y se enciende cuando su sección está activa. Se compara con
    // pl.idx (la sección a la que pertenece), no con la posición en el array.
    pl.halo.material.opacity = pl.baseHalo * (0.78 + Math.sin(gt*1.3 + pl.idx)*0.12)
                             * (pl.idx === activeIdx ? 1.9 : 1) * (1 - apagadoCine);
  }
  if(bigPlanet) bigPlanet.rotation.y += dt*0.02;
  for(const p of planetasProc) p.actualizar(dt);

  // El HUD sólo se toca cuando cambia el entero: escribir en el DOM cada frame
  // fuerza recálculo de estilo 60 veces por segundo para nada.
  const pct = Math.round(progress*100);
  if(pct !== lastPct){
    lastPct = pct;
    hudPct.textContent = String(pct).padStart(3,'0') + '%';
    progressFill.style.height = pct + '%';
  }

  dibujar();

  // Medidor (sólo con ?debug o pulsando D). Se lee DESPUÉS de dibujar porque
  // renderer.info se rellena durante el render; se refresca 4 veces por segundo para
  // que los números se puedan leer y no cueste nada apreciable.
  if(perfPanel && document.body.classList.contains('debug')){
    fpsMuestras++;
    if(gt - fpsDesde >= 0.25){
      const info = renderer.info;
      perfPanel.textContent =
        `calidad  ${NIVEL}${Q.bloom ? ' +bloom' : ''}${Q.sombras ? ' +sombras' : ''}\n` +
        `fps      ${Math.round(fpsMuestras/(gt - fpsDesde))}\n` +
        `draws    ${info.render.calls}\n` +
        `triáng.  ${info.render.triangles.toLocaleString('es')}\n` +
        `geom/tex ${info.memory.geometries}/${info.memory.textures}\n` +
        `progreso ${(progress*100).toFixed(1)}%  ${zone.name}`;
      fpsDesde = gt; fpsMuestras = 0;
    }
  }
}

aplicarResolucion(factorTitulo());
animate();

// ── Herramienta de desarrollo ──
// Sólo existe con `npm run dev`: Vite sustituye import.meta.env.DEV por false en el build
// y el bloque entero desaparece del paquete de producción (comprobado en dist/).
// Permite avanzar la escena fotograma a fotograma y capturar imágenes aunque la
// pestaña esté oculta, que es cuando el navegador congela requestAnimationFrame.
if(import.meta.env.DEV){
  window.__dev = {
    THREE, scene, camera, renderer,
    frame, dibujar,
    get mode(){ return mode; }, get progress(){ return progress; },
    get escalaTiempo(){ return escalaTiempo; },
    // Salta a vuelo libre en el punto t del recorrido, sin portada ni despegue.
    // Por defecto marca como vistas las cinemáticas anteriores a t: si no, saltar por
    // encima de su punto de inicio las dispara y la captura sale a mitad de escena.
    volarA(t, { cines = false } = {}){
      startOverlay.style.display = 'none';
      document.body.classList.remove('en-portada');
      if(factorRes < 1) aplicarResolucion(1);
      if(mode === 'cine'){ limpiarCombate(); director.end(); cineIdx = -1; }
      mode = 'free'; progress = targetProgress = t;
      // Con cines:true sólo queda pendiente la escena que empieza en t; las anteriores
      // se dan por vistas (si no, saltar al agujero dispararía antes el combate).
      CINEMATICAS.forEach(c=> c.hecha = cines ? c.t < t - 0.01 : c.t <= t + 0.01);
    },
    sun, get bloomPass(){ return bloomPass; }, aplicarResolucion, factorTitulo, TITULO_CAM,
    get bigPlanet(){ return bigPlanet; }, waypointPlanets, planetasProc,
    cambiarPaleta(nombre){ for(const p of planetasProc) p.aplicarPaleta(PALETAS[nombre][p.bioma]); }, director, ctxCombate, ctxAgujero, enemigos, CINEMATICAS,
    avanzar(seg, paso = 1/60){ for(let s=0; s<seg; s+=paso) frame(paso); },
    captura(tipo = 'image/jpeg'){ dibujar(); return renderer.domElement.toDataURL(tipo, 0.88); },
  };
  import('./dev.js').then(m => m.instalarBanco(window.__dev));
}


addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  // Respeta el modo píxel de la portada (y recalcula su factor: depende del alto).
  // Se decide por el ESTADO (¿seguimos en la portada?), no por el factor anterior: si
  // éste se hubiera calculado mal una vez, se arrastraría para siempre.
  aplicarResolucion(enfoque.activo ? factorRes : (mode === 'idle' ? factorTitulo() : 1));
  if(bloomPass) bloomPass.resolution.set(innerWidth, innerHeight);
});
