import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendWhatsApp } from './whatsapp.ts';

beforeEach(() => {
  vi.stubEnv('EVOLUTION_API_URL', 'https://evo.test');
  vi.stubEnv('EVOLUTION_API_KEY', 'evo-key');
  vi.stubEnv('EVOLUTION_INSTANCE', 'kairos');
  vi.stubEnv('WHATSAPP_CONTROL_NUMBER', '573001234567');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendWhatsApp', () => {
  test('hace POST al endpoint de Evolution con apikey y body number+text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: { id: 'msg-1' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendWhatsApp('hola');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://evo.test/message/sendText/kairos');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('evo-key');
    expect(JSON.parse(init.body)).toEqual({ number: '573001234567', text: 'hola' });
    expect(result.messageId).toBe('msg-1');
  });

  test('lanza cuando Evolution responde no-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(sendWhatsApp('x')).rejects.toThrow();
  });

  test('lanza cuando falta configuración de Evolution', async () => {
    vi.stubEnv('EVOLUTION_API_URL', '');
    await expect(sendWhatsApp('x')).rejects.toThrow();
  });
});
