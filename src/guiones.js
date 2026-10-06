// ── Guiones de las cinemáticas ────────────────────────────────────────────────
// Cada función devuelve un guion NUEVO por reproducción: algunos planos guardan estado
// propio (el punto fijo de la pasada), y no debe arrastrarse de una vuelta a otra.
//
// Los `hasta` están alineados con los sucesos de la simulación (main.js):
//   combate  → bajas en u = 0.30 / 0.62 / 0.92, tonel entre 0.36 y 0.58
//   agujero  → arrastre desde 0.28, caída 0.58–0.72, salto de gusano en 0.72
import * as THREE from 'three';
import { enMarco } from './director.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

// Punto medio ponderado: t = 0 → a, t = 1 → b.
const entre = (out, a, b, t) => out.copy(a).lerp(b, t);

export function guionCombate() {
  const ancla = new THREE.Vector3();          // cámara fija de la pasada (plano 6)
  return {
    titulo: 'Emboscada',
    subtitulo: 'Sector 7 · cinturón exterior',
    planos: [
      { // 1 · REVELACIÓN — teleobjetivo de lado: la nave cruza el plano y, al fondo,
        //     los tres cazas se descuelgan, vistos en tres cuartos desde arriba.
        hasta: 0.10, fov: 44,
        // Posición elegida con __dev.buscarEncuadre sobre el movimiento real del plano:
        // cero fotogramas fuera y nada delante. Por el otro lado el primer caza quedaba
        // pegado a la lente, y a 30 de lado la cámara caía dentro del cinturón.
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -34 + k*3, 14, -14);
                            entre(o.look, c.ship.position, c.E(0), 0.45); },
        enCuadro: c => [c.ship.position, c.E(0)],
      },
      { // 2 · CONTRAPLANO — por delante de los cazas mirando atrás: ellos en primer
        //     término y tu nave al fondo. Se presenta a la amenaza.
        hasta: 0.19, fov: 56,
        cam: (c, k, o) => { entre(_a, c.E(0), c.E(1), 0.5);
                            enMarco(o.pos, _a, c, 3, 2.5, 17 - k*3);
                            entre(o.look, c.ship.position, _a, 0.3); },
        enCuadro: c => [c.ship.position, c.E(0), c.E(1)],
      },
      { // 3 · PERSECUCIÓN — pegado a la cola, el primer caza delante.
        hasta: 0.27, fov: 58,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -2, 3.2, -9);
                            entre(o.look, c.ship.position, c.E(0), 0.65); },
        enCuadro: c => [c.ship.position, c.E(0)],
      },
      { // 4 · PRIMER DERRIBO — cámara lenta. Empieza ANTES de la baja (u 0.30) para ver
        //     al caza quebrando y luego reventar; a media distancia y con tele, para que
        //     la explosión no se coma el cuadro.
        hasta: 0.335, fov: 34, tiempo: 0.25,
        cam: (c, k, o) => { enMarco(o.pos, c.E(0), c, 16, 4, -16 + k*3);
                            o.look.copy(c.E(0)); },
        enCuadro: c => [c.E(0)],
      },
      { // 5 · FUEGO CRUZADO — sobre el hombro y gran angular: el segundo caza dispara
        //     y los rayos pasan rozando la lente.
        hasta: 0.46, fov: 68,
        alEntrar: c => c.disparoCercano(1),
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, 1.6, 0.9, -4.5);
                            entre(o.look, c.ship.position, c.E(1), 0.8); },
        enCuadro: c => [c.ship.position, c.E(1)],
      },
      { // 6 · LA PASADA — cámara FIJA en el espacio, por delante y a un lado. La nave
        //     viene de frente haciendo el tonel y cruza junto a la lente.
        hasta: 0.59, fov: 40,
        alEntrar: c => { enMarco(ancla, c.ship.position, c, 3.4, 1.3, 9); c.sonido('whoosh'); },
        cam: (c, k, o) => { o.pos.copy(ancla); o.look.copy(c.ship.position); },
        enCuadro: c => [c.ship.position],
      },
      { // 7 · SEGUNDO DERRIBO — contrapicado y cámara lenta (baja en u 0.62).
        hasta: 0.655, fov: 36, tiempo: 0.25,
        cam: (c, k, o) => { enMarco(o.pos, c.E(1), c, 10, -14, -12);
                            o.look.copy(c.E(1)); },
        enCuadro: c => [c.E(1)],
      },
      { // 8 · CAZA FINAL — por detrás y algo lejos, con cámara en mano.
        hasta: 0.89, fov: 50, temblor: 0.25,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -3, 4, -13);
                            entre(o.look, c.ship.position, c.E(2), 0.75); },
        enCuadro: c => [c.ship.position, c.E(2)],
      },
      { // 9 · ÚLTIMO DERRIBO — plano abierto y lento (baja en u 0.92).
        hasta: 0.955, fov: 34, tiempo: 0.3,
        cam: (c, k, o) => { enMarco(o.pos, c.E(2), c, -20, 7, 12);
                            o.look.copy(c.E(2)); },
        enCuadro: c => [c.E(2)],
      },
      { // 10 · SALIDA — corte SECO a la cámara de vuelo y se devuelve el control.
        //      Se probó un travelling desde el plano 9: atravesaba el espacio entre la
        //      explosión y la nave, ésta salía de cuadro (NDC 2.5) y la escena terminaba
        //      antes que la mezcla. Un corte limpio es además lo que hacen los juegos.
        hasta: 1.01,
        cam: (c, k, o) => { o.pos.copy(c.chasePos); o.look.copy(c.chaseLook); },
        enCuadro: c => [c.ship.position],
      },
    ],
  };
}

// ── Agujero negro: Interstellar / Outer Wilds ──
// El marco de esta escena apunta HACIA EL AGUJERO (F = nave → agujero) mientras éste tira
// de la nave; tras el salto de gusano (u 0.72) vuelve a la dirección de la ruta.
// Sujeto H = centro del agujero.
export function guionAgujero() {
  return {
    titulo: 'Anomalía gravitatoria',
    subtitulo: 'Sector 9 · horizonte de sucesos',
    planos: [
      { // 1 · ANOMALÍA — teleobjetivo desde lejos: la nave es una mota contra el disco.
        //     La escala es el mensaje: aquí la nave no manda.
        hasta: 0.16, fov: 30,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -20, 8, -46 + k*4);
                            entre(o.look, c.ship.position, c.H, 0.55); },
        enCuadro: c => [c.ship.position, { p: c.H, r: 26 }],
      },
      { // 2 · CONTRAPLANO — tres cuartos de la nave con el agujero detrás. Empieza a temblar.
        hasta: 0.30, fov: 40, temblor: 0.2,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, 6, 1.5, -6);
                            entre(o.look, c.ship.position, c.H, 0.08); },
        enCuadro: c => [c.ship.position, { p: c.H, r: 26 }],
      },
      { // 3 · RASANTE — pegado detrás, gran angular: el disco llena el cuadro y tiembla todo.
        hasta: 0.48, fov: 72, temblor: 0.9,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, 1.5, 2.5, -8);
                            entre(o.look, c.ship.position, c.H, 0.3); },
        enCuadro: c => [c.ship.position, { p: c.H, r: 26 }],
      },
      { // 4 · ARRASTRE — tres cuartos trasero por la izquierda (el plano 2 iba por la
        //     derecha): la nave a contraluz del disco, sacudida. Un perfil puro dejaba el
        //     agujero fuera (está delante y el perfil mira a 90°); posición elegida con
        //     __dev.buscarEncuadre exigiendo nave y agujero dentro.
        hasta: 0.58, fov: 50, temblor: 1.0,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -9, 1, -16);
                            entre(o.look, c.ship.position, c.H, 0.08); },
        enCuadro: c => [c.ship.position, { p: c.H, r: 26 }],
      },
      { // 5 · EL BORDE — cámara lenta: la nave en barrena justo antes de cruzar.
        hasta: 0.66, fov: 44, tiempo: 0.3, temblor: 0.4,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, -7, 3, -3);
                            o.look.copy(c.ship.position); },
        enCuadro: c => [c.ship.position],
      },
      { // 6 · LA CAÍDA — gran angular extremo hacia el negro; termina en blanco (main.js).
        hasta: 0.72, fov: 85, temblor: 1.2,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, 0, 1.8, -5);
                            entre(o.look, c.ship.position, c.H, 0.5); },
        enCuadro: c => [{ p: c.H, r: 26 }],
      },
      { // 7 · SALIDA — corte en el blanco: la nave aparece en otro punto del mapa, vista
        //     de frente mientras se acerca. El marco ya es el de la ruta.
        hasta: 0.86, fov: 42,
        cam: (c, k, o) => { enMarco(o.pos, c.ship.position, c, 4, 2, 22 - k*8);
                            o.look.copy(c.ship.position); },
        enCuadro: c => [c.ship.position],
      },
      { // 8 · VUELTA AL CONTROL — corte seco a la cámara de vuelo.
        hasta: 1.01,
        cam: (c, k, o) => { o.pos.copy(c.chasePos); o.look.copy(c.chaseLook); },
        enCuadro: c => [c.ship.position],
      },
    ],
  };
}
