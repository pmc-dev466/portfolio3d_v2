// Optimiza los modelos para la web: assets-src/models (originales) → src/models.
//
//   npm run models
//
// Los originales se conservan para poder repetir el proceso con otros ajustes (o
// recuperar animaciones) sin perder calidad por recomprimir lo ya comprimido.
//
// Pipeline, medido sobre los 19 modelos en uso: 1921 KB → 541 KB (−72 %).
//   dedup + weld + prune   vértices duplicados y datos sin referenciar fuera
//   quantize               posiciones/normales/UV de float32 a enteros de 8-16 bits
//   meshopt                compresión de geometría; se descomprime en el navegador
//                          con un decodificador WebAssembly (ver main.js y la CSP)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'assets-src/models';
const OUT = 'src/models';

// Modelos que NO van a la web. Se guardan como fuente por si se usan más adelante.
const SKIP = new Set(['alien.glb']);
// Animaciones a conservar por modelo. Lo que no aparezca aquí se queda sin animaciones:
// el astronauta trae 18 (169 KB) y ahora mismo se muestra estático.
const KEEP_ANIMATIONS = { 'astronaut.glb': [] };

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

fs.mkdirSync(OUT, { recursive: true });
let before = 0, after = 0;
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.glb')).sort()) {
  if (SKIP.has(file)) continue;
  const doc = await io.read(path.join(SRC, file));
  const keep = KEEP_ANIMATIONS[file];
  if (keep) for (const a of doc.getRoot().listAnimations()) if (!keep.includes(a.getName())) a.dispose();

  await doc.transform(dedup(), weld(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const bin = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT, file), bin);

  const a = fs.statSync(path.join(SRC, file)).size;
  before += a; after += bin.byteLength;
  console.log(`${file.padEnd(28)} ${(a / 1024).toFixed(0).padStart(5)} KB → ${(bin.byteLength / 1024).toFixed(0).padStart(4)} KB`);
}
console.log(`${'TOTAL'.padEnd(28)} ${(before / 1024).toFixed(0).padStart(5)} KB → ${(after / 1024).toFixed(0).padStart(4)} KB  (−${(100 - after / before * 100).toFixed(0)} %)`);
