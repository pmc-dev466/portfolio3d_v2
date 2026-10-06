import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: {
    // main.js usa await en el nivel superior del módulo (carga bajo demanda del
    // postprocesado). es2022 es el primer objetivo que lo admite sin transformarlo.
    target: 'es2022',
    // three.js va en su propio chunk: es lo que menos cambia entre despliegues, así
    // que un cambio en la app no obliga a volver a descargarlo.
    // three.js minificado ronda los 570 KB por sí solo: el aviso de 500 KB no aporta.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) { if (id.includes('node_modules/three')) return 'three'; },
      },
    },
  },
});
