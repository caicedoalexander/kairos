import { describe, test, expect } from 'vitest';
import health from './health.ts';

describe('health', () => {
  test('GET /health responde 200 con status ok y el modo actual', async () => {
    const res = await health.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(['sim', 'testnet', 'live']).toContain(body.mode);
  });
});
