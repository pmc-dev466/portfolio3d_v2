// ── Banco de pruebas de cinemáticas (sólo `npm run dev`) ─────────────────────────
// main.js lo importa bajo import.meta.env.DEV, así que no existe en producción.
//
// Uso en la consola del navegador:
//   await __dev.ensayarCine(0.301)            // combate
//   await __dev.ensayarCine(0.521, 'agujero') // agujero negro
//
// Reproduce la escena a 60 fps fijos —aunque la pestaña esté oculta— y, plano a plano,
// comprueba que lo que el guion declara en `enCuadro` se ve de verdad: dentro del cuadro
// y sin nada opaco delante. Devuelve el informe y un fotograma por plano.
//
// Existe porque los cinco primeros intentos del combate fallaron por lo mismo: el
// encuadre se daba por bueno sin medirlo.
export function instalarBanco(dev) {
  const { THREE } = dev;
  const P = new THREE.Vector3(), dir = new THREE.Vector3(), ray = new THREE.Raycaster();

  dev.ensayarCine = async (inicioT, ctxNombre = 'ctxCombate', { maxSeg = 45 } = {}) => {
    dev.volarA(inicioT, { cines: true });
    const opacos = [];
    dev.scene.traverse(o => { if (o.isMesh && !o.material.transparent) opacos.push(o); });
    const porPlano = {}, fotos = [], vistos = new Set();
    let entro = false, real = 0;
    for (let f = 0; f < 60 * maxSeg; f++) {
      dev.frame(1 / 60); real += 1 / 60;
      if (dev.mode === 'cine') entro = true;
      if (entro && dev.mode !== 'cine') break;
      if (!dev.director.activo) continue;
      const ctx = dev[ctxNombre], i = dev.director.plano, pl = dev.director.guion.planos[i];
      const r = porPlano[i] ??= { real: 0, frames: 0, fuera: 0, tapado: 0, peorNdc: 0, distMin: 1e9 };
      r.real += 1 / 60; r.frames++;
      dev.camera.updateMatrixWorld();
      for (const suj of pl.enCuadro(ctx)) {
        // Un sujeto puede ser un punto o { p, r }: los cuerpos grandes (el agujero, radio
        // 26) se taparían a sí mismos si se mide la oclusión hasta su centro.
        const s = suj.isVector3 ? suj : suj.p, radio = suj.isVector3 ? 0 : suj.r;
        P.copy(s).project(dev.camera);
        const m = Math.max(Math.abs(P.x), Math.abs(P.y));
        if (P.z > 1 || m > 0.92) r.fuera++;
        r.peorNdc = Math.max(r.peorNdc, P.z > 1 ? 99 : m);
        if (r.frames % 4 === 0) {                 // el raycast contra la escena entera cuesta
          const d = dev.camera.position.distanceTo(s);
          ray.set(dev.camera.position, dir.subVectors(s, dev.camera.position).normalize());
          ray.far = d;
          const h = ray.intersectObjects(opacos, false).find(h => h.object.visible);
          if (h && h.distance < d - 3 - radio) r.tapado += 4;
        }
      }
      r.distMin = Math.min(r.distMin, dev.camera.position.distanceTo(ctx.ship.position));
      // Foto hacia la mitad del plano (en tiempo REAL: los planos lentos duran más)
      if (!vistos.has(i) && r.real > 0.16 / (pl.tiempo ?? 1)) { vistos.add(i); fotos.push([i + 1, dev.captura()]); }
    }
    const informe = Object.entries(porPlano).map(([i, r]) =>
      `${+i + 1}: ${r.real.toFixed(1)}s fuera=${r.fuera} tapado=${r.tapado} ndc=${r.peorNdc.toFixed(2)} dist=${r.distMin.toFixed(1)}`);
    return { segundos: +real.toFixed(1), informe, fotos };
  };

  // ── Buscador de encuadres ──
  // Graba UNA vez lo que pasa durante un plano (posiciones y marco de la escena por
  // frame) y evalúa sobre esa grabación muchas cámaras candidatas sin re-simular.
  // Candidata = desplazamiento (lado, arriba, adelante) respecto a un ancla, y punto de
  // mira entre la nave (mira=0) y el objetivo (mira=1).
  dev.grabarPlano = (inicioT, indice, ctxNombre = 'ctxCombate', anclas) => {
    dev.volarA(inicioT, { cines: true });
    const frames = []; let entro = false;
    for (let f = 0; f < 60 * 45; f++) {
      dev.frame(1 / 60);
      if (dev.mode === 'cine') entro = true;
      if (entro && dev.mode !== 'cine') break;
      if (dev.director.plano !== indice) { if (frames.length) break; else continue; }
      const c = dev[ctxNombre];
      frames.push({ F: c.F.clone(), R: c.R.clone(), U: c.U.clone(), puntos: anclas(c).map(v => v.clone()) });
    }
    return frames;
  };
  // puntos[0] = ancla de la cámara, puntos[1] = objetivo de la mira; el resto también
  // deben verse. Devuelve las mejores candidatas ordenadas.
  dev.buscarEncuadre = (frames, { lados, arribas, adelantes, miras, fov, comprobar = 99 }) => {
    const opacos = [];
    dev.scene.traverse(o => { if (o.isMesh && !o.material.transparent && o.visible) opacos.push(o); });
    const cam = new THREE.PerspectiveCamera(fov, dev.camera.aspect, 0.1, 4000);
    const pos = new THREE.Vector3(), look = new THREE.Vector3(), res = [];
    for (const lado of lados) for (const arriba of arribas) for (const adelante of adelantes) for (const mira of miras) {
      let fuera = 0, tapado = 0, peor = 0;
      for (let i = 0; i < frames.length; i++) {
        const fr = frames[i], [ancla, objetivo] = fr.puntos;
        pos.copy(ancla).addScaledVector(fr.R, lado).addScaledVector(fr.U, arriba).addScaledVector(fr.F, adelante);
        look.copy(ancla).lerp(objetivo, mira);
        cam.position.copy(pos); cam.lookAt(look); cam.updateMatrixWorld();
        for (const p of fr.puntos.slice(0, comprobar)) {
          P.copy(p).project(cam);
          const m = P.z > 1 ? 99 : Math.max(Math.abs(P.x), Math.abs(P.y));
          if (m > 0.85) fuera++; peor = Math.max(peor, m);
          if (i % 6 === 0) {
            const d = pos.distanceTo(p);
            ray.set(pos, dir.subVectors(p, pos).normalize()); ray.far = d;
            if (ray.intersectObjects(opacos, false).some(h => h.distance < d - 3)) tapado++;
          }
        }
      }
      res.push({ lado, arriba, adelante, mira, fuera, tapado, peor: +peor.toFixed(2) });
    }
    return res.sort((a, b) => (a.fuera + a.tapado * 6) - (b.fuera + b.tapado * 6) || a.peor - b.peor);
  };

  // Hoja de contactos: junta las fotos en una sola imagen (dataURL).
  dev.hojaContactos = async (fotos, { W = 426, H = 240, cols = 3 } = {}) => {
    const c = document.createElement('canvas');
    c.width = W * cols; c.height = H * Math.ceil(fotos.length / cols);
    const cx = c.getContext('2d');
    cx.fillStyle = '#000'; cx.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < fotos.length; k++) {
      const im = new Image();
      await new Promise(r => { im.onload = r; im.src = fotos[k][1]; });
      cx.drawImage(im, (k % cols) * W, Math.floor(k / cols) * H, W, H);
      cx.fillStyle = '#ff0'; cx.font = 'bold 14px monospace';
      cx.fillText('plano ' + fotos[k][0], (k % cols) * W + 8, Math.floor(k / cols) * H + 20);
    }
    return c.toDataURL('image/jpeg', 0.85);
  };
}
