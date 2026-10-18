// ── Control del recorrido: rueda, arrastre táctil con inercia y teclado ──────────
//
// Sustituye al scroll nativo de un <div> de 2400vh, que era lo que hacía raro el móvil:
//  · Al desplazarse, el navegador escondía y sacaba la barra de direcciones. Eso cambia
//    `innerHeight`, por tanto el total desplazable, por tanto el progreso: la nave
//    pegaba saltos a mitad de gesto. Y cada cambio disparaba un `resize` completo del
//    renderer, que daba tirones.
//  · El mismo dedo que hacía scroll movía también la cámara (el parallax escuchaba
//    `touchmove`), así que deslizar para avanzar hacía cabecear el plano.
// Ahora la página no se desplaza nunca: la barra no se mueve, y el gesto sólo avanza.
//
// Este módulo no conoce el estado de la escena. Acumula cuánto hay que avanzar y el
// bucle de animación lo recoge con `consume(dt)` una vez por frame.

// Equivalencias con el sistema anterior, para que en escritorio la rueda se sienta
// igual que antes: el recorrido completo eran 23 alturas de pantalla de scroll.
const SCREENS_PER_ROUTE_WHEEL = 23;
// En táctil se pide menos: 23 deslizamientos de pantalla completa para cruzar el
// recorrido era agotador. Con 13 y la inercia, un deslizamiento normal te lleva de un
// planeta al siguiente en dos o tres gestos.
const SCREENS_PER_ROUTE_TOUCH = 13;
// Frenado de la inercia (por segundo). 3.2 deja planear ~0.6 s tras soltar: lo justo
// para que se note, sin que la nave siga avanzando cuando ya no lo esperas.
const FRICTION = 3.2;
// Pasos de teclado, en fracción del recorrido.
const KEY_STEP = 1 / 70;
const PAGE_STEP = 1 / 22;

// Elementos sobre los que un arrastre NO debe pilotar la nave: tienen su propio
// desplazamiento (los paneles) o su propio significado (botones y enlaces).
const IGNORE = '#infoPanel, #finalPanel, button, a, #startOverlay, #crawlScreen';

export function createRouteInput({ isEnabled, onFirstMove }) {
  let pending = 0;          // avance acumulado desde el último consume(), en progreso
  let velocity = 0;         // inercia tras soltar el dedo, en progreso/s
  let touchId = null, lastY = 0, lastT = 0, sampledVel = 0;
  let moved = false;

  const push = (delta) => {
    if (!isEnabled()) return;
    pending += delta;
    if (!moved && delta > 0) { moved = true; onFirstMove?.(); }
  };

  // ── Rueda y trackpad ──
  // No se añade inercia propia: los trackpads ya traen la del sistema, y sumarle otra
  // hace que el desplazamiento "patine". El suavizado del bucle basta.
  function onWheel(e) {
    if (!isEnabled()) return;
    // deltaMode 1 = líneas (Firefox con rueda), 2 = páginas. Se pasa todo a píxeles.
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    push(px / (SCREENS_PER_ROUTE_WHEEL * innerHeight));
  }

  // ── Táctil ──
  function onPointerDown(e) {
    if (e.pointerType !== 'touch' || touchId !== null) return;
    if (e.target.closest?.(IGNORE)) return;
    touchId = e.pointerId;
    lastY = e.clientY; lastT = e.timeStamp;
    sampledVel = 0;
    velocity = 0;            // tocar la pantalla frena en seco, como en cualquier lista
  }
  function onPointerMove(e) {
    if (e.pointerId !== touchId) return;
    const dy = lastY - e.clientY;                         // hacia arriba = avanzar
    const dt = Math.max(1, e.timeStamp - lastT) / 1000;
    const delta = dy / (SCREENS_PER_ROUTE_TOUCH * innerHeight);
    push(delta);
    // Velocidad suavizada: el último evento suelto es demasiado ruidoso para lanzar
    // la inercia con él (un dedo que se para justo antes de soltar daría cero).
    sampledVel = sampledVel * 0.6 + (delta / dt) * 0.4;
    lastY = e.clientY; lastT = e.timeStamp;
  }
  function onPointerUp(e) {
    if (e.pointerId !== touchId) return;
    touchId = null;
    // Si el dedo llevaba más de 100 ms quieto antes de soltar, no hay lanzamiento.
    velocity = (e.timeStamp - lastT) > 100 ? 0 : sampledVel;
  }

  // ── Teclado ── (también es lo que hace navegable la web sin ratón)
  function onKey(e) {
    // Con el foco en un botón o enlace, espacio y flechas son SUYOS: si no, la barra
    // espaciadora sobre el botón de silencio haría avanzar la nave en vez de pulsarlo.
    if (!isEnabled() || e.target.closest?.('input, textarea, button, a')) return;
    const step = {
      ArrowDown: KEY_STEP, ArrowRight: KEY_STEP, ArrowUp: -KEY_STEP, ArrowLeft: -KEY_STEP,
      PageDown: PAGE_STEP, ' ': e.shiftKey ? -PAGE_STEP : PAGE_STEP, PageUp: -PAGE_STEP,
    }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    push(step);
  }

  addEventListener('wheel', onWheel, { passive: true });
  addEventListener('pointerdown', onPointerDown, { passive: true });
  addEventListener('pointermove', onPointerMove, { passive: true });
  addEventListener('pointerup', onPointerUp, { passive: true });
  addEventListener('pointercancel', onPointerUp, { passive: true });
  addEventListener('keydown', onKey);

  return {
    // Hay un dedo apoyado o la nave aún planea por la inercia del último gesto. El
    // piloto automático lo usa para apartarse mientras el usuario manda.
    get activo() { return touchId !== null || velocity !== 0; },
    // Devuelve cuánto avanzar en este frame, incluida la inercia.
    consume(dt) {
      if (!isEnabled()) { pending = 0; velocity = 0; return 0; }
      if (touchId === null && velocity !== 0) {
        pending += velocity * dt;
        velocity *= Math.exp(-FRICTION * dt);
        if (Math.abs(velocity) < 1e-4) velocity = 0;
      }
      const d = pending;
      pending = 0;
      return d;
    },
    // Al llegar a un extremo del recorrido la inercia se corta: si no, quedaría
    // "empujando" contra el tope y al dar la vuelta habría un retraso fantasma.
    stopMomentum() { velocity = 0; },
    reset() { pending = 0; velocity = 0; touchId = null; moved = false; },
  };
}
