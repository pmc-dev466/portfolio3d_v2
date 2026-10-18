// Pruebas de src/autopilot.js: crucero, paradas en cada sección, «Continuar» y
// cesión del control al dedo. Se simula el bucle con un dt fijo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilot } from '../src/autopilot.js';

const PARADAS = [0.06, 0.22, 0.40, 0.86];
const DT = 1 / 60;
const nuevo = () => createAutopilot({ paradas: PARADAS });
// Avanza `seg` segundos sin tocar. El progreso real se toma igual al objetivo: aquí no
// interesa el suavizado del bucle, sólo a dónde manda el piloto.
function volar(ap, obj, seg, tocando = false) {
  for (let s = 0; s < seg; s += DT) obj = ap.update(DT, obj, obj, tocando);
  return obj;
}

test('arranca solo y se para EXACTAMENTE en la primera sección', () => {
  const ap = nuevo();
  const obj = volar(ap, 0.015, 30);
  assert.equal(obj, 0.06);
  assert.equal(ap.estado, 'parado');
  assert.equal(ap.parada, 0);
});

test('frena aunque el objetivo se quede a una millonésima de la sección', () => {
  // Pasaba de verdad tras el agujero negro: sumando pasos el objetivo quedaba en
  // 0.8599999…, se daba la sección por pasada y la nave cruzaba Formación sin parar.
  const ap = nuevo();
  const obj = volar(ap, 0.86 - 4e-7, 5);
  assert.equal(obj, 0.86);
  assert.equal(ap.parada, 3);
});

test('parado no avanza por mucho que pase el tiempo', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.015, 30);
  obj = volar(ap, obj, 60);
  assert.equal(obj, 0.06);
});

test('«Continuar» lleva a la siguiente sección y no vuelve a frenar en la misma', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.015, 30);
  ap.continuar();
  obj = volar(ap, obj, 30);
  assert.equal(obj, 0.22);
  assert.equal(ap.parada, 1);
});

test('el crucero acelera progresivamente, sin saltar a la velocidad máxima', () => {
  const ap = nuevo();
  const a = ap.update(DT, 0.1, 0.1, false) - 0.1;
  assert.ok(a > 0 && a < 0.012 * DT / 2, `primer paso demasiado brusco: ${a}`);
});

test('pulsar «Continuar» en la aproximación (antes de parar) no frena en esa sección', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.21, 0.2);       // a punto de llegar a Skills, aún en crucero
  assert.equal(ap.estado, 'crucero');
  ap.continuar(1);                      // el panel de Skills ya está a la vista
  obj = volar(ap, obj, 40);
  assert.equal(obj, 0.40);
});

test('el dedo toma el control y el piloto retoma tras 2.5 s quieto', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.10, 1);
  obj = ap.update(DT, obj + 0.02, obj + 0.02, true);   // gesto
  assert.equal(ap.estado, 'manual');
  const tras = volar(ap, obj, 2);                     // 2 s sin tocar: sigue quieto
  assert.equal(tras, obj);
  volar(ap, tras, 1);
  assert.equal(ap.estado, 'crucero');
});

test('si el dedo te deja en una sección, al retomar se queda parado en ella', () => {
  const ap = nuevo();
  ap.update(DT, 0.39, 0.39, true);
  volar(ap, 0.39, 3);
  assert.equal(ap.estado, 'parado');
  assert.equal(ap.parada, 2);
});

test('tras la última sección sigue hasta el final del recorrido', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.85, 5);
  assert.equal(obj, 0.86);
  ap.continuar();
  obj = volar(ap, obj, 20);
  assert.ok(obj > 1, 'debe empujar más allá de 1 (el bucle lo recorta y aterriza)');
});

test('volver atrás por debajo de una sección ya dejada la rearma', () => {
  const ap = nuevo();
  let obj = volar(ap, 0.015, 30);       // parado en 0.06
  ap.continuar();
  obj = volar(ap, obj, 3);
  ap.update(DT, 0.0, 0.0, true);        // el dedo lo devuelve al principio
  obj = volar(ap, 0.0, 40);
  assert.equal(obj, 0.06);
});
