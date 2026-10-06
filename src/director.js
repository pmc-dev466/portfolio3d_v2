// ── Director de cinemáticas ───────────────────────────────────────────────────
//
// Las cinemáticas antiguas eran UNA cámara deslizándose de una pose a otra. Eso se lee
// como "la cámara acompaña", no como una escena de videojuego. Las cinemáticas de juego
// (Squadrons, Mass Effect, Outer Wilds) están hechas de PLANOS y CORTES: un general, un
// contraplano, un detalle a cámara lenta, una pasada rozando la lente.
//
// Este módulo sólo dirige la cámara y la puesta en escena (barras, rótulo, tiempo,
// temblor). Lo que pasa en el mundo —por dónde vuelan los cazas, cuándo caen, cómo
// tira el agujero de la nave— sigue en main.js y avanza con `u` (0→1 de la escena).
//
// Un guion es:
//   { titulo, subtitulo, planos: [ {
//       hasta,        u en el que termina el plano (el siguiente empieza ahí)
//       cam(ctx, k, out)  coloca out.pos / out.look; k = 0→1 dentro del plano
//       fov,          lente en grados (más bajo = teleobjetivo, más plano y épico)
//       corte,        'seco' (salto, por defecto) | 'mezcla' (travelling desde el anterior)
//       mezcla,       segundos REALES que dura la mezcla
//       tiempo,       escala de tiempo del mundo: 1 normal, 0.25 cámara lenta
//       temblor,      temblor de mano permanente durante el plano (0-1)
//       alEntrar(ctx) gancho al empezar el plano (disparos, sonidos…)
//       enCuadro(ctx) lista de puntos que DEBEN verse; sólo lo usa la verificación
//   } ] }
import * as THREE from 'three';

const _pos = new THREE.Vector3(), _look = new THREE.Vector3();
const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3();

export function createDirector({ camera, baseFov }) {
  const barras = document.getElementById('barrasCine');
  const rotulo = document.getElementById('rotuloCine');
  let guion = null, indice = -1, tiempoReal = 0, rotuloHasta = 0;
  // Pose actual y pose de partida de una mezcla.
  const actual = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: baseFov, roll: 0 };
  const desde = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: baseFov };
  let mezclaT = 0, mezclaDur = 0;
  // Trauma: modelo de sacudida de juegos (Eiserloh, GDC 2016). Los impactos lo suben,
  // decae solo, y el temblor es proporcional a su CUADRADO: los golpes pequeños apenas
  // se notan y los grandes sacuden de verdad, que es como se percibe un impacto.
  let trauma = 0;

  const out = { pos: new THREE.Vector3(), look: new THREE.Vector3() };

  function planoEn(u) {
    const ps = guion.planos;
    for (let i = 0; i < ps.length; i++) if (u < ps[i].hasta) return i;
    return ps.length - 1;
  }

  function entrarEn(i, ctx) {
    const p = guion.planos[i];
    if (p.corte === 'mezcla' && indice >= 0) {
      desde.pos.copy(actual.pos); desde.look.copy(actual.look); desde.fov = actual.fov;
      mezclaT = 0; mezclaDur = p.mezcla ?? 0.6;
    } else {
      mezclaDur = 0;
    }
    indice = i;
    p.alEntrar?.(ctx);
  }

  return {
    get activo() { return guion !== null; },
    get plano() { return guion ? indice : -1; },
    get guion() { return guion; },
    get fov() { return actual.fov; },
    // Escala de tiempo que pide el plano actual. main.js la aplica con una rampa corta.
    get escalaTiempo() { return guion ? (guion.planos[indice]?.tiempo ?? 1) : 1; },

    start(nuevo, ctx) {
      guion = nuevo; indice = -1; tiempoReal = 0; trauma = 0;
      document.body.classList.add('en-cine');
      barras?.classList.add('on');
      if (rotulo && guion.titulo) {
        rotulo.querySelector('.rc-titulo').textContent = guion.titulo;
        rotulo.querySelector('.rc-sub').textContent = guion.subtitulo ?? '';
        rotulo.classList.add('on');
        rotuloHasta = 3.2;
      }
      entrarEn(0, ctx);
    },

    // Golpe de cámara. 0.3 = disparo cercano, 0.7 = explosión, 1 = choque.
    impacto(cantidad) { if (guion) trauma = Math.min(1, trauma + cantidad); },

    update(u, dtReal, ctx) {
      tiempoReal += dtReal;
      if (rotuloHasta && tiempoReal > rotuloHasta) { rotulo?.classList.remove('on'); rotuloHasta = 0; }

      const i = planoEn(u);
      if (i !== indice) entrarEn(i, ctx);
      const p = guion.planos[i];
      const ini = i === 0 ? 0 : guion.planos[i - 1].hasta;
      const k = THREE.MathUtils.clamp((u - ini) / Math.max(1e-6, p.hasta - ini), 0, 1);

      p.cam(ctx, k, out);
      let fov = p.fov ?? baseFov;
      if (mezclaDur > 0 && mezclaT < mezclaDur) {
        mezclaT += dtReal;
        const w = THREE.MathUtils.smootherstep(mezclaT / mezclaDur, 0, 1);
        out.pos.lerpVectors(desde.pos, out.pos, w);
        out.look.lerpVectors(desde.look, out.look, w);
        fov = desde.fov + (fov - desde.fov) * w;
      }
      actual.pos.copy(out.pos); actual.look.copy(out.look); actual.fov = fov;

      // Temblor: trauma de los impactos + temblor de mano del plano. Suma de senos de
      // frecuencias no múltiplos (no se repite a la vista) en lugar de ruido aleatorio
      // por frame, que se percibe como vibración eléctrica y no como cámara en mano.
      trauma = Math.max(0, trauma - dtReal * 1.1);
      const s = trauma * trauma + (p.temblor ?? 0) * 0.35;
      const t = tiempoReal;
      _pos.copy(out.pos); _look.copy(out.look);
      if (s > 0.001) {
        _fwd.subVectors(_look, _pos).normalize();
        _right.crossVectors(_fwd, camera.up).normalize();
        _up.crossVectors(_right, _fwd);
        const ox = (Math.sin(t * 37.1) + Math.sin(t * 23.3 + 1.7) * 0.6) * 0.55 * s;
        const oy = (Math.sin(t * 41.7 + 0.4) + Math.sin(t * 19.9 + 2.9) * 0.6) * 0.55 * s;
        _pos.addScaledVector(_right, ox).addScaledVector(_up, oy);
        _look.addScaledVector(_right, ox * 0.35).addScaledVector(_up, oy * 0.35);
      }
      camera.position.copy(_pos);
      camera.lookAt(_look);
      if (s > 0.001) camera.rotateZ((Math.sin(t * 29.3) + Math.sin(t * 13.1 + 0.8) * 0.5) * 0.045 * s);
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },

    end() {
      guion = null; indice = -1; trauma = 0;
      document.body.classList.remove('en-cine');
      barras?.classList.remove('on');
      rotulo?.classList.remove('on');
      rotuloHasta = 0;
    },
  };
}

// ── Utilidades para escribir planos ──
// Coloca un punto en el marco de la escena: lado (R), arriba (U), adelante (F).
export function enMarco(out, base, ctx, lado, arriba, adelante) {
  return out.copy(base)
    .addScaledVector(ctx.R, lado)
    .addScaledVector(ctx.U, arriba)
    .addScaledVector(ctx.F, adelante);
}
