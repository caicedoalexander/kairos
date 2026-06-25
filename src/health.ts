import { Hono } from 'hono';
import { getMode } from './lib/mode.ts';

const health = new Hono();

health.get('/health', (c) => c.json({ status: 'ok', mode: getMode() }));

export default health;
