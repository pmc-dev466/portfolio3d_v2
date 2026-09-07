// Servidor estático mínimo para previsualizar el recorrido en local.
// Hace falta sí o sí: los modelos y app.js se cargan por fetch, y file:// lo bloquea.
// Uso:  npm run dev          (puerto 5173, o el siguiente libre)
//       npm run dev -- 8080  (puerto concreto)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, no pathname: en Windows la URL trae "/C:/..." con barras normales y
// path.join devuelve backslashes, así que el startsWith de abajo fallaba siempre.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT_BASE = Number(process.argv[2]) || 5173;
const INTENTOS = 12;
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.glb':'model/gltf-binary', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.woff2':'font/woff2', '.woff':'font/woff',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(path.join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// Si el puerto está ocupado (otra pestaña, otro `npm run dev`, o un servidor que quedó
// vivo), buscar el siguiente libre en vez de reventar con un EADDRINUSE sin explicar.
let puerto = PORT_BASE;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && puerto < PORT_BASE + INTENTOS) {
    console.log(`  puerto ${puerto} ocupado, probando ${puerto + 1}…`);
    server.listen(++puerto);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`\nNo hay puertos libres entre ${PORT_BASE} y ${puerto}.`);
    console.error('Cierra el servidor que esté corriendo, o indica otro:  npm run dev -- 8080\n');
    process.exit(1);
  } else {
    throw err;
  }
});
server.listen(puerto, () => console.log(`\n  Recorrido en http://localhost:${puerto}/\n`));
