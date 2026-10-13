# Portfolio 3D — recorrido en nave

Portfolio personal montado como un pequeño videojuego en 3D: pilotas una nave por una ruta
y cada planeta que encuentras es una sección del currículum. Arranca con una pantalla de
título en píxel («PULSA K PARA CONTINUAR») y una intro a lo Star Wars; por el camino hay un
cinturón de asteroides con disparo automático, un combate y un agujero negro en forma de
cinemáticas de videojuego, una estación abandonada y un aterrizaje final con los datos de
contacto. Los planetas se generan por shader en estilo cartoon.

Hecho con **three.js** y **Vite**, sin framework y **sin una sola petición a terceros**.

---

## Cómo se ejecuta en local

```bash
npm install
npm run dev
```

Levanta Vite en `http://localhost:5173` con recarga en caliente. Para comprobar el build de
producción tal cual se despliega:

```bash
npm run build
npm run preview
```

### Controles

| | |
|---|---|
| Empezar | `K`, `Enter`, `Espacio` o click / toque en la portada |
| Avanzar | rueda, flechas, `AvPág`/`RePág`, o arrastrar el dedo (con inercia) |
| Sonido | `M` (arranca siempre en silencio) |
| Saltar la intro | click, tecla o rueda |

### Niveles de calidad

Se detectan solos (los dispositivos móviles arrancan en `baja`), pero se pueden forzar por
query string:

| URL | Sombras | Resolución máx. | Rocas | Partículas |
|---|---|---|---|---|
| `?q=alta` | sí, 2048 px | DPR 1.8 | 78 | 900 |
| `?q=media` | sí, 1024 px | DPR 1.5 | 52 | 550 |
| `?q=baja` | no | DPR 1.0 | 32 | 320 |

En `alta` y `media` hay bloom; en `baja` ni se descarga. Los planetas usan 5, 4 o 3
octavas de ruido según el nivel.

La paleta se puede forzar con `?paleta=caramelo` (por defecto) o `?paleta=vibrante`.

---

## Estructura

```
index.html          Shell: CSS embebido y overlays del DOM
src/main.js         La aplicación: escena, recorrido y bucle
src/input.js        Rueda, arrastre táctil con inercia y teclado
src/director.js     Director de cinemáticas: planos, cortes, cámara lenta, barras
src/guiones.js      Guiones (listas de planos) del combate y del agujero negro
src/planetas.js     Planetas generados por shader (ruido simplex, cartoon)
src/paletas.js      ÚNICO sitio de los colores: planetas, cielo y ajuste del kit
src/dev.js          Banco de pruebas de cinemáticas (sólo en npm run dev)
src/models/         Modelos optimizados (generados, no se editan a mano)
assets-src/models/  Modelos originales — la fuente de verdad
scripts/            optimize-models.mjs: assets-src → src/models (npm run models)
tests/              Pruebas de la entrada táctil, rueda y teclado (npm test)
src/fonts/          Fuentes woff2 autoalojadas + fonts.css
public/_headers     Cabeceras de caché y seguridad para Cloudflare Pages
vite.config.js      three.js va en su propio chunk, separado de la app
```

### Decisiones que conviene conocer antes de tocar nada

- **Modelos comprimidos con meshopt** (1,9 MB → 382 KB; los planetas ya no son modelos). Si cambias o añades uno, ponlo en
  `assets-src/models/` y ejecuta `npm run models`; nunca edites `src/models/` a mano.
  Van cuantizados: si hornear transformaciones en la geometría, pásala antes a float32
  (`aFlotante()` en main.js) o los valores se recortan a ±1.

- **Bloom sin perder el antialiasing.** `EffectComposer` por defecto renderiza sin
  multimuestreo y desactiva el MSAA del lienzo; por eso se le da un render target propio
  con `samples: 4` en HalfFloat. En coma flotante las mezclas aditivas no se saturan en
  1.0: la estela del motor usa mezcla por MÁXIMO y las explosiones se atenúan con bloom.
- **Colores: todo sale de `paletas.js`.** Los modelos del kit comparten un único atlas
  de color, que se reescribe al cargar con el ajuste de la paleta; el escenario hecho en
  código (hangares, puertas) pasa por la misma función. Para cambiar el aspecto del mundo
  no hay que tocar ningún modelo.
- **Planetas por shader.** Cada sección tiene su bioma. Ojo con `pow()` en GLSL: con
  base negativa da NaN, y el bloom lo esparce en bloques negros. Se acota con `clamp`.
- **Cinemáticas = guiones de planos.** Cada plano declara en `enCuadro` qué tiene que
  verse. Con `npm run dev`, en la consola: `await __dev.ensayarCine(0.301)` (combate) o
  `await __dev.ensayarCine(0.521, 'ctxAgujero')` reproduce la escena a 60 fps fijos y
  dice, plano a plano, si algo se sale de cuadro o queda tapado.
- **El cielo es el color de la niebla.** Comparten el mismo objeto `Color`; si no, lo
  lejano se recorta sobre el cielo como una silueta plana.
- **Fuentes autoalojadas.** Nada de `fonts.googleapis.com`: así no se filtra la IP de quien
  visita la página. Van con `unicode-range`, de modo que los subsets `latin-ext` sólo se
  descargan si el texto los necesita.
- **Audio 100% procedural.** No hay ni un fichero de sonido: todo se sintetiza con la Web
  Audio API. **Arranca siempre silenciado** y se activa con la tecla `M` o el botón.
- **Cero asignaciones por frame.** El bucle de animación reutiliza vectores y matrices de un
  pool (`_p`, `_tan`, `_cv1`…). Si añades código ahí, no crees objetos nuevos dentro.
- **Independencia de la tasa de refresco.** Las interpolaciones usan
  `smoothK(rate, dt) = 1 - (1-rate)^(dt*60)`, no un factor fijo por frame.
- Los modelos vienen de FBX2glTF con un nodo hijo a `scale=100`. `bakedGeometry()` hornea
  `matrixWorld` en la geometría; si coges `child.geometry` a pelo, los objetos salen 100
  veces más pequeños.

---

## Despliegue en Cloudflare Pages

Cloudflare compila el proyecto con Vite en cada despliegue.

> **Si el proyecto ya estaba creado** (versión 1, sin build): antes de subir esta versión,
> cambia en sus ajustes de build el *Build command* y el *Build output directory* a los
> valores de la tabla. Si no, Cloudflare publicaría el código fuente sin compilar y la
> página no arrancaría.

1. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elige este repositorio.
3. Configuración de build:

   | Campo | Valor |
   |---|---|
   | Framework preset | `None` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | *(vacío)* |

4. **Save and Deploy.**

`public/_headers` acaba en la raíz de `dist/` y Cloudflare lo aplica solo: CSP sin
`unsafe-inline` en scripts, cabeceras de seguridad y caché. Todo lo que genera Vite lleva un
hash en el nombre, así que `/assets/*` se cachea un año sin riesgo de servir versiones
viejas; `index.html` se revalida siempre.

La versión de Node la fija `.node-version`.

No hace falta `_redirects`: esto es una única página, no una SPA con rutas.

> **No uses Git LFS con este repositorio.** Cloudflare Pages no resuelve los punteros de LFS
> durante el checkout, así que los `.glb` llegarían como ficheros de texto y el sitio
> arrancaría sin ningún modelo. Los originales (`assets-src/`) y los optimizados juntos van
> perfectamente en git normal.

### Lo único que queda por rellenar a mano

Cuando sepas el dominio definitivo, añade al `<head>` de `index.html`:

```html
<link rel="canonical" href="https://TU-DOMINIO/">
<meta property="og:url" content="https://TU-DOMINIO/">
<meta property="og:image" content="https://TU-DOMINIO/og.png">
<meta name="twitter:card" content="summary_large_image">
```

Se han omitido a propósito: una etiqueta con un dominio inventado da peor resultado que no
ponerla. La imagen `og.png` (1200×630) tampoco existe todavía — hasta que la haya, la vista
previa al compartir sale sin imagen pero con título y descripción correctos.

---

## Licencias

El **código** es MIT.

Los **modelos 3D** proceden de kits de terceros: *Ultimate Space Kit* de
[Quaternius](https://quaternius.com/) y *Space Kit* de [Kenney](https://kenney.nl/). Ambos
autores publican habitualmente bajo **CC0 (dominio público)**, lo que no exigiría atribución
—aunque se da igualmente—, pero **confirma la licencia en la página de descarga de cada kit
antes de publicar**, porque las condiciones pueden variar de un kit a otro y esta nota no
sustituye a lo que diga el autor.

Las **fuentes** (Archivo Black, Bebas Neue, DM Sans, IBM Plex Mono, News Cycle) están bajo
SIL Open Font License 1.1.
