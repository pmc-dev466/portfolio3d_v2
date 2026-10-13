// ── Paletas de los planetas ───────────────────────────────────────────────────
// Un único sitio para los colores del mundo. Cada planeta tiene un bioma propio y
// reconocible; las dos paletas son el mismo diseño con distinto carácter:
//   vibrante  colores saturados y contrastados, a lo No Man's Sky
//   caramelo  más claros y suaves, a lo Astroneer
// La que se usa la fija PALETA_ACTIVA (y se puede forzar con ?paleta= para comparar).
//
// nivelMar: altura (0-1) por debajo de la cual hay agua. Más alto = más océano.
// nubosidad: umbral del ruido de nubes. Más alto = menos nubes.

export const PALETAS = {
  vibrante: {
    // 01 · Experiencia — desierto de cañones con algún lago.
    experiencia: { oceanoProfundo: 0x0d6e8a, oceano: 0x1fc4d6, arena: 0xffe2a0, tierra: 0xffa040,
      tierraAlta: 0xe8603a, roca: 0x9a3a2e, nieve: 0xfff1d6, atmosfera: 0xffa35c, nubes: 0xfff3e2,
      nivelMar: 0.38, nubosidad: 0.66 },
    // 02 · Skills — archipiélago tropical.
    skills: { oceanoProfundo: 0x0b3fa8, oceano: 0x22c6e0, arena: 0xfff09a, tierra: 0x3fd776,
      tierraAlta: 0x1a9a55, roca: 0x3f6a58, nieve: 0xffffff, atmosfera: 0x5fe6ff, nubes: 0xffffff,
      nivelMar: 0.56, nubosidad: 0.66 },
    // 03 · Proyectos — mundo helado con mares violeta.
    proyectos: { oceanoProfundo: 0x2a1e8c, oceano: 0x5a52ff, arena: 0xbfe6ff, tierra: 0x8fd3ff,
      tierraAlta: 0xd8f2ff, roca: 0x6f86ff, nieve: 0xffffff, atmosfera: 0x8fb4ff, nubes: 0xe8f4ff,
      nivelMar: 0.47, nubosidad: 0.68 },
    // 04 · Formación — mundo alienígena de vegetación magenta.
    formacion: { oceanoProfundo: 0x26145a, oceano: 0x6a3cff, arena: 0xffd0ec, tierra: 0xff5cb2,
      tierraAlta: 0xc23a96, roca: 0x6a2a7a, nieve: 0xffe6f6, atmosfera: 0xff86d6, nubes: 0xfff0fa,
      nivelMar: 0.5, nubosidad: 0.6 },
    // Planeta del picado — el "hogar": océanos, selva y nubes.
    hogar: { oceanoProfundo: 0x0f4fbf, oceano: 0x23b6ee, arena: 0xffe48a, tierra: 0x5ad65a,
      tierraAlta: 0x2a9a3c, roca: 0x7a6a55, nieve: 0xffffff, atmosfera: 0x7fd4ff, nubes: 0xffffff,
      nivelMar: 0.52, nubosidad: 0.65 },
  },
  caramelo: {
    experiencia: { oceanoProfundo: 0x4fa3b8, oceano: 0x8fe0e6, arena: 0xfff0cc, tierra: 0xffc48a,
      tierraAlta: 0xf29a7a, roca: 0xc97a6e, nieve: 0xfffaf0, atmosfera: 0xffd0a8, nubes: 0xffffff,
      nivelMar: 0.38, nubosidad: 0.66 },
    skills: { oceanoProfundo: 0x4f86d6, oceano: 0x8fe4f0, arena: 0xfff6c2, tierra: 0x9be8b0,
      tierraAlta: 0x5fc48a, roca: 0x8fae9e, nieve: 0xffffff, atmosfera: 0xa8f0ff, nubes: 0xffffff,
      nivelMar: 0.56, nubosidad: 0.66 },
    proyectos: { oceanoProfundo: 0x7a74d6, oceano: 0xa9a4ff, arena: 0xe2f4ff, tierra: 0xc4e8ff,
      tierraAlta: 0xeef9ff, roca: 0xa9b8ff, nieve: 0xffffff, atmosfera: 0xc2d4ff, nubes: 0xffffff,
      nivelMar: 0.47, nubosidad: 0.68 },
    formacion: { oceanoProfundo: 0x7e66b8, oceano: 0xb39cff, arena: 0xffe6f4, tierra: 0xffa8d6,
      tierraAlta: 0xe88ac0, roca: 0xa87ab8, nieve: 0xfff4fb, atmosfera: 0xffc2e8, nubes: 0xffffff,
      nivelMar: 0.5, nubosidad: 0.6 },
    hogar: { oceanoProfundo: 0x5a8fe0, oceano: 0x8fd8f6, arena: 0xfff2c2, tierra: 0xa8eaa0,
      tierraAlta: 0x6fcf7a, roca: 0xb3a48f, nieve: 0xffffff, atmosfera: 0xb4e6ff, nubes: 0xffffff,
      nivelMar: 0.52, nubosidad: 0.65 },
  },
};

// Planeta de cada sección, en el orden de WAYPOINTS (main.js).
export const BIOMA_SECCION = ['experiencia', 'skills', 'proyectos', 'formacion'];

const pedida = new URLSearchParams(location.search).get('paleta');
export const PALETA_ACTIVA = PALETAS[pedida] ? pedida : 'caramelo';

// ── Cielo por zona ──
// Color del cielo (= niebla, ver main.js) en cada zona del recorrido, en el orden de
// ZONES, y colores de la nebulosa. null = los originales (casi negros).
// En caramelo el espacio deja de ser negro: índigo profundo, todavía oscuro para que
// destaquen planetas y estrellas, y la entrada atmosférica se vuelve azul de verdad.
export const CIELOS = {
  caramelo: {
    zonas: [0x161c3a, 0x1b1f3d, 0x2a2050, 0x3f5c8e, 0x1a2444, 0x161c3a],
    nebulosa: [0xb48cff, 0x8ca4ff, 0x86e8d8, 0xff9cc6],
  },
  vibrante: null,
};

// ── Ajuste del kit de modelos ─────────────────────────────────────────────────
// Todos los modelos del kit (nave, cazas, rocas, estación…) toman su color de UNA misma
// textura: un atlas de cuadritos de 16 px. Reescribiéndola se recolorea el kit entero de
// forma coherente con los planetas, sin tocar modelo a modelo.
// Se conserva el TONO de cada color (la nave sigue naranja, los cazas rosas) y se
// mueven luz y saturación hacia la paleta elegida:
//   luz        [mín, máx]: el rango de luminosidad al que se reescala la original. Subir
//              el mínimo es lo que quita los negros duros de los cascos.
//   saturacion multiplicador.
//   gris       los colores sin apenas saturación (los grises del casco) se tiñen con
//              este tono suave, en vez de quedarse en un gris neutro que no pega con nada.
export const AJUSTE_KIT = {
  caramelo: { luz: [0.30, 0.90], saturacion: 0.72, gris: { tono: 0.70, saturacion: 0.14 } },
  vibrante: null,     // sin ajuste: los colores originales del kit
};

// Reescribe una imagen (el atlas) y devuelve un canvas. Se hace una sola vez al cargar.
export function ajustarAtlas(imagen, ajuste) {
  const c = document.createElement('canvas');
  c.width = imagen.width; c.height = imagen.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(imagen, 0, 0);
  const datos = cx.getImageData(0, 0, c.width, c.height);
  const p = datos.data;
  for (let i = 0; i < p.length; i += 4) {
    const [r, g, b] = ajustarRGB(p[i] / 255, p[i + 1] / 255, p[i + 2] / 255, ajuste);
    p[i] = r * 255; p[i + 1] = g * 255; p[i + 2] = b * 255;
  }
  cx.putImageData(datos, 0, 0);
  return c;
}

// La misma transformación, para un color suelto (0xRRGGBB → 0xRRGGBB). La usa el
// escenario construido en código (hangares, plataformas, puertas): así casa con el kit
// sin elegir colores a mano uno por uno.
export function ajustarColor(hex, ajuste) {
  if (!ajuste) return hex;
  const [r, g, b] = ajustarRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, ajuste);
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

function ajustarRGB(r, g, b, ajuste) {
  let [h, s, l] = rgbAHsl(r, g, b);
  if (s < 0.12) { h = ajuste.gris.tono; s = ajuste.gris.saturacion; }
  else s = Math.min(1, s * ajuste.saturacion);
  l = ajuste.luz[0] + l * (ajuste.luz[1] - ajuste.luz[0]);
  return hslARgb(h, s, l);
}

function rgbAHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslARgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
