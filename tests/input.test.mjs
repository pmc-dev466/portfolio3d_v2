// Pruebas de src/input.js con eventos sintéticos y tiempos controlados.
// El bucle de animación no interviene: se comprueba sólo cuánto avance produce cada
// gesto, que es lo que cambió al dejar de depender del scroll nativo.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const handlers = {};
globalThis.addEventListener = (t, fn) => (handlers[t] ||= []).push(fn);
globalThis.innerHeight = 812;
const fuera = { closest: () => null };
const fire = (t, ev) => handlers[t].forEach(fn => fn({ target: fuera, preventDefault() {}, ...ev }));
const { createRouteInput } = await import('../src/input.js');

let enabled, firstMove, inp;
beforeEach(() => {
  for (const k in handlers) delete handlers[k];
  enabled = true; firstMove = 0;
  inp = createRouteInput({ isEnabled: () => enabled, onFirstMove: () => firstMove++ });
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
function swipe(id, t0, { dy = 406, steps = 10, ms = 200 } = {}) {
  fire('pointerdown', { pointerType: 'touch', pointerId: id, clientY: 700, timeStamp: t0 });
  for (let i = 1; i <= steps; i++)
    fire('pointermove', { pointerId: id, clientY: 700 - (dy * i) / steps, timeStamp: t0 + (ms * i) / steps });
}

test('arrastrar media pantalla avanza 1/26 del recorrido y avisa una sola vez', () => {
  swipe(1, 0);
  near(inp.consume(1 / 60), 0.5 / 13);
  assert.equal(firstMove, 1);
});

test('al soltar en movimiento hay inercia, y se apaga en menos de 3 s', () => {
  swipe(1, 0); inp.consume(1 / 60);
  fire('pointerup', { pointerId: 1, timeStamp: 205 });
  let extra = 0, frames = 0, d;
  do { d = inp.consume(1 / 60); extra += d; frames++; } while (d > 0 && frames < 600);
  assert.ok(extra > 0.01);
  assert.ok(frames / 60 < 3);
});

test('dedo quieto antes de soltar: sin lanzamiento', () => {
  swipe(1, 0, { dy: 100, steps: 1, ms: 20 }); inp.consume(1 / 60);
  fire('pointerup', { pointerId: 1, timeStamp: 320 });
  assert.equal(inp.consume(1 / 60), 0);
});

test('tocar la pantalla frena la inercia en seco', () => {
  swipe(1, 0); fire('pointerup', { pointerId: 1, timeStamp: 205 }); inp.consume(1 / 60);
  fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientY: 400, timeStamp: 300 });
  assert.equal(inp.consume(1 / 60), 0);
});

test('un arrastre que empieza sobre un panel no pilota', () => {
  handlers.pointerdown.forEach(fn => fn({ pointerType: 'touch', pointerId: 9, clientY: 700, timeStamp: 0, target: { closest: () => ({}) } }));
  fire('pointermove', { pointerId: 9, clientY: 300, timeStamp: 50 });
  assert.equal(inp.consume(1 / 60), 0);
});

test('arrastrar con ratón no avanza', () => {
  fire('pointerdown', { pointerType: 'mouse', pointerId: 1, clientY: 700, timeStamp: 0 });
  fire('pointermove', { pointerId: 1, clientY: 300, timeStamp: 50 });
  assert.equal(inp.consume(1 / 60), 0);
});

test('rueda: una pantalla = 1/23, igual que con el scroll nativo; líneas a píxeles', () => {
  fire('wheel', { deltaY: 812, deltaMode: 0 });
  near(inp.consume(1 / 60), 1 / 23);
  fire('wheel', { deltaY: 3, deltaMode: 1 });
  near(inp.consume(1 / 60), 48 / (23 * 812));
});

test('teclado: flechas y avance de página; con foco en un botón no actúa', () => {
  fire('keydown', { key: 'ArrowDown' }); fire('keydown', { key: 'PageUp' });
  near(inp.consume(1 / 60), 1 / 70 - 1 / 22);
  handlers.keydown.forEach(fn => fn({ key: ' ', target: { closest: () => ({}) }, preventDefault() {} }));
  assert.equal(inp.consume(1 / 60), 0);
});

test('en cinemática se descarta todo y no hay salto acumulado al volver', () => {
  enabled = false;
  fire('wheel', { deltaY: 5000, deltaMode: 0 });
  assert.equal(inp.consume(1 / 60), 0);
  enabled = true;
  assert.equal(inp.consume(1 / 60), 0);
});
