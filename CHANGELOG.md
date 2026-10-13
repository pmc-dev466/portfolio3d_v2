# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones
según [SemVer](https://semver.org/lang/es/).

## [2.0.0] — 2026-10-13

Versión 2: el portfolio pasa de "escena 3D con scroll" a algo que se siente como un
videojuego, y pesa bastante menos.

### Añadido
- **Pantalla de título** estilo videojuego: fuente píxel, «PULSA K PARA CONTINUAR» con
  parpadeo a saltos y la escena del hangar renderizada en píxel gordo detrás. Al terminar
  la intro, la imagen se "enfoca" a saltos hasta la resolución completa al despegar.
- **Cinemáticas con director**: el combate y el agujero negro son ahora guiones de planos
  con cortes, cámara lenta, temblor de cámara, barras de cine y rótulo de escena.
  - Emboscada (10 planos): revelación, contraplano, derribos a cámara lenta, disparos
    rozando la lente y una pasada con tonel.
  - Anomalía gravitatoria (8 planos): el arrastre, el borde a cámara lenta, la caída y la
    salida por el agujero de gusano.
- **Planetas generados por shader** en estilo cartoon: relieve, biomas, nubes en
  movimiento y atmósfera. Un mundo distinto por sección.
- **Paleta caramelo** aplicada a todo el mundo (planetas, kit de modelos, hangares, cielo)
  desde un único fichero, `src/paletas.js`.
- **Controles**: rueda, flechas y `AvPág`/`RePág`, arrastre táctil con inercia, `K` para
  empezar y `M` para el sonido.
- **Banco de pruebas de cinemáticas** (sólo en desarrollo): reproduce cada escena a 60 fps
  fijos y comprueba plano a plano que nada se sale de cuadro ni queda tapado.
- Pruebas automáticas de la entrada (`npm test`).

### Cambiado
- Migración a **Vite**: código minificado y ficheros con hash, cacheables un año sin
  riesgo de servir versiones viejas.
- **Modelos comprimidos** con meshopt: 1,9 MB → 382 KB (−80 %).
- **Bloom** de vuelta, sin perder el antialiasing.
- El cielo toma el color de la niebla de cada zona.
- CSP más estricta: sin `unsafe-inline` en scripts.

### Corregido
- **Móvil**: el avance dependía del scroll del navegador; la barra de direcciones cambiaba
  el alto de la ventana a mitad de gesto y la nave pegaba saltos.
- Siluetas planas en escalera flotando en el cielo (la fachada del hangar final, vista
  desde lejos).
- El planeta del picado se veía casi sólo niebla, como una bola sin modelo.
- La nave salía fuera de cuadro en el combate.
- En el combate los cazas explotaban antes de que les llegara el disparo. Ahora el rayo
  sale antes, persigue al caza y lo alcanza en el fotograma exacto de la explosión.

### Despliegue
- Cloudflare Pages debe usar *Build command* `npm run build` y *Build output directory*
  `dist` (antes no había build). Ver README.

## [1.0.0]

Primera versión publicada: recorrido en nave por las secciones del portfolio, intro a lo
Star Wars, cinturón de asteroides, combate, agujero negro, estación abandonada y
aterrizaje final con los datos de contacto.

[2.0.0]: https://github.com/pmc-dev466/portfolio3d_v2/compare/0577a18...v2.0.0
