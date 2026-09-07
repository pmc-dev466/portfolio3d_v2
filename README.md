# Portfolio 3D — recorrido en nave

Portfolio personal montado como una experiencia de scroll en 3D: pilotas una nave por una
ruta y cada planeta que encuentras es una sección del currículum. Por el camino hay un
cinturón de asteroides con disparo automático, un combate guionizado contra tres cazas, un
agujero negro que funciona como salto espacial, una estación abandonada y un aterrizaje
final con los datos de contacto.

Hecho con **three.js**, sin framework, **sin paso de compilación** y **sin una sola petición
a terceros**.

---

## Cómo se ejecuta en local

Hace falta un servidor HTTP: los modelos y el propio `app.js` se cargan por `fetch`, y el
protocolo `file://` lo bloquea. Abrir el `index.html` con doble clic **no funciona** (la
propia página te avisa si lo intentas).

```bash
npm run dev
```

Levanta un servidor estático en `http://localhost:5173`. Si el puerto está ocupado busca el
siguiente libre. Para forzar uno concreto:

```bash
npm run dev -- 8080
```

No hay `npm install`: el proyecto no tiene dependencias. `three.js` va incluido en
`vendor/three/`.

### Niveles de calidad

Se detectan solos (los dispositivos móviles arrancan en `baja`), pero se pueden forzar por
query string:

| URL | Sombras | Resolución máx. | Rocas | Partículas |
|---|---|---|---|---|
| `?q=alta` | sí, 2048 px | DPR 1.8 | 78 | 900 |
| `?q=media` | sí, 1024 px | DPR 1.5 | 52 | 550 |
| `?q=baja` | no | DPR 1.0 | 32 | 320 |

---

## Estructura

```
index.html          Shell: CSS embebido, overlays del DOM, importmap
app.js              La aplicación entera (módulo ES, ~168 KB)
assets/             20 modelos .glb (2,2 MB)
fonts/              8 fuentes woff2 autoalojadas + fonts.css (308 KB)
vendor/three/       three.js r0.160 + addons (857 KB)
_headers            Cabeceras de caché y seguridad para Cloudflare Pages
dev-server.mjs      Servidor estático, sólo para desarrollo
```

### Decisiones que conviene conocer antes de tocar nada

- **Sin postprocesado.** Se quitó el bloom a propósito: `EffectComposer` renderiza a un
  render target sin `samples`, lo que **desactiva silenciosamente el MSAA 4x del lienzo**.
  Quitarlo mejoró la calidad de los bordes (medido: `gl.SAMPLES = 4`).
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

El repositorio se conecta directamente: no hay nada que compilar.

1. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elige este repositorio.
3. Configuración de build:

   | Campo | Valor |
   |---|---|
   | Framework preset | `None` |
   | Build command | *(vacío)* |
   | Build output directory | `/` |
   | Root directory | *(vacío)* |

4. **Save and Deploy.**

El fichero `_headers` lo recoge Cloudflare automáticamente y aplica la CSP, las cabeceras de
seguridad y la política de caché (un año para `assets/`, `fonts/` y `vendor/`, que son
inmutables; revalidación siempre para `index.html` y `app.js`, que cambian en cada despliegue).

No hace falta `_redirects`: esto es una única página, no una SPA con rutas.

> **No uses Git LFS con este repositorio.** Cloudflare Pages no resuelve los punteros de LFS
> durante el checkout, así que los `.glb` llegarían como ficheros de texto y el sitio
> arrancaría sin ningún modelo. Los 2,2 MB en 20 ficheros van perfectamente en git normal.

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
