import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import health from './health.ts';
import { startShadowWorker } from './shadow/shadow-worker.ts';

// SP7: el worker de shadow-eval vive en el runtime Flue para poder llamar invoke() in-process.
startShadowWorker();

const app = new Hono();

// Rutas propias (health) + rutas generadas por Flue (agentes, workflows, canales) sin prefijo.
app.route('/', health);
app.route('/', flue());

export default app;
