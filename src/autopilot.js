// ── Piloto automático (táctil) ────────────────────────────────────────────────
//
// En móvil, avanzar arrastrando el dedo era incómodo: hacían falta muchos gestos y,
// a la vez, había que leer los paneles. El piloto lleva la nave sola entre secciones y
// SE PARA en cada una hasta que el usuario pulsa «Continuar». Un avance continuo a
// velocidad fija no servía: los tramos vacíos se hacían eternos y en las secciones
// largas no daba tiempo a leer.
//
// El dedo sigue mandando: en cuanto hay gesto, el piloto se aparta (estado 'manual') y
// retoma solo tras unos segundos sin tocar. Si al retomar la nave está en una sección,
// se queda parada en ella: el usuario ha ido allí a propósito.
//
// Como input.js, no conoce la escena: recibe el objetivo de progreso y lo devuelve
// avanzado. Así se prueba en Node sin three.js.

export function createAutopilot({
  paradas,                 // progreso (0-1) de cada sección, en orden
  velocidad = 0.012,       // progreso/s de crucero: ~13 s entre secciones contiguas
  aceleracion = 0.8,       // segundos para llegar a crucero al arrancar. Con 1.4 la salida
                           // tras «Continuar» era tan suave que parecía que no arrancaba
  reanudarTras = 2.5,      // segundos sin tocar tras los que el piloto retoma
  radio = 0.045,           // distancia a la que una sección cuenta como "aquí"
}) {
  let estado = 'crucero';  // 'crucero' | 'parado' | 'manual'
  let parada = -1;         // índice de la sección en la que está parado
  let vel = 0, quieto = 0;
  // Última sección que se dejó atrás con «Continuar». Sin esto, al pulsar el botón
  // antes de llegar a pararse (el panel ya se ve en la aproximación), la nave volvería
  // a frenar en esa misma sección.
  let pasada = -Infinity;

  const cercana = (p) => {
    let mejor = -1, d = radio;
    for (let i = 0; i < paradas.length; i++) {
      const di = Math.abs(paradas[i] - p);
      if (di < d) { d = di; mejor = i; }
    }
    return mejor;
  };

  return {
    get estado() { return estado; },
    get parada() { return parada; },

    // objetivo: progreso hacia el que va la nave. progreso: dónde está de verdad.
    // tocando: hubo gesto en este frame (o hay inercia del dedo).
    update(dt, objetivo, progreso, tocando) {
      if (tocando) {
        estado = 'manual'; parada = -1; vel = 0; quieto = 0;
        return objetivo;
      }
      // Si el usuario vuelve atrás por debajo de la sección que dejó, se rearma.
      if (objetivo < pasada - radio) pasada = -Infinity;

      if (estado === 'manual') {
        quieto += dt;
        if (quieto < reanudarTras) return objetivo;
        const i = cercana(progreso);
        if (i >= 0 && paradas[i] > pasada) { estado = 'parado'; parada = i; }
        else estado = 'crucero';
      }
      if (estado === 'parado') return objetivo;

      vel = Math.min(velocidad, vel + velocidad * dt / aceleracion);
      // >= y sin margen: al ir sumando pasos el objetivo puede quedarse en 0.8599999…, y
      // con un margen "por seguridad" la parada se daba por pasada y la nave la cruzaba
      // sin frenar. No volver a frenar en la sección recién dejada ya lo garantiza `pasada`.
      let siguiente = -1;
      for (let i = 0; i < paradas.length; i++) {
        if (paradas[i] >= objetivo && paradas[i] > pasada) { siguiente = i; break; }
      }
      let nuevo = objetivo + vel * dt;
      if (siguiente >= 0 && nuevo >= paradas[siguiente]) {
        nuevo = paradas[siguiente];
        estado = 'parado'; parada = siguiente; vel = 0;
      }
      return nuevo;
    },

    // «Continuar». `seccion` es la que muestra el panel: puede pulsarse ya en la
    // aproximación, antes de que la nave llegue a pararse.
    continuar(seccion = parada) {
      if (seccion >= 0) pasada = paradas[seccion];
      estado = 'crucero'; parada = -1; quieto = 0;
    },

    reset() { estado = 'crucero'; parada = -1; vel = 0; quieto = 0; pasada = -Infinity; },
  };
}
