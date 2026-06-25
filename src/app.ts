import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import health from './health.ts';

const app = new Hono();

// Rutas propias (health) + rutas generadas por Flue (agentes, workflows, canales) sin prefijo.
app.route('/', health);
app.route('/', flue());

export default app;
