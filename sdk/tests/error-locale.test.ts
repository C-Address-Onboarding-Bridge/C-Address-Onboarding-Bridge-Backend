import { describe, it, expect } from 'vitest';
import { AuthError, TimeoutError, QueueFullError, parseHttpError } from '../src/errors';
import { es } from '../src/i18n/es';

describe('Error classes locale support (#882)', () => {
  it('produces Spanish catalog text for a 401 AuthError with locale: es', () => {
    const err = new AuthError(undefined, { statusCode: 401, locale: 'es' });
    expect(err.message).toBe(es['error.auth.unauthorized']);
    expect(err.message).toBe('No autorizado. Comprueba tu clave de API.');
  });

  it('produces Spanish catalog text for a 401 via parseHttpError with locale: es', () => {
    const err = parseHttpError(401, {}, undefined, 'es');
    expect(err.message).toBe(es['error.auth.unauthorized']);
  });

  it('produces Spanish catalog text for a TimeoutError with locale: es', () => {
    const err = new TimeoutError('GET /status', 5000, { locale: 'es' });
    expect(err.message).toBe('La operación "GET /status" expiró después de 5000 ms.');
  });

  it('produces Spanish catalog text for a QueueFullError with locale: es', () => {
    const err = new QueueFullError(50, { locale: 'es' });
    expect(err.message).toBe('La cola sin conexión está llena (máximo 50 entradas). La solicitud fue descartada.');
  });
});
