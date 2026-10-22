import { describe, it, expect } from 'vitest';
import {
  parseHttpError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ServerError,
} from '../errors';

describe('parseHttpError', () => {
  it('maps a zod 400 validation_error body to ValidationError.fields', () => {
    const body = {
      error: 'validation_error',
      details: [
        { path: ['address'], message: 'Invalid Stellar address' },
        { path: ['amount'], message: 'Expected number, received string' },
      ],
    };

    const err = parseHttpError(400, body);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe('validation_error');
    expect(err.message).toBe('validation_error');
    expect((err as ValidationError).fields).toEqual({
      address: 'Invalid Stellar address',
      amount: 'Expected number, received string',
    });
  });

  it('maps a 401 expired_api_key body to AuthenticationError with code', () => {
    const err = parseHttpError(401, { error: 'expired_api_key' });

    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe('expired_api_key');
    expect(err.message).toBe('expired_api_key');
  });

  it('maps a 403 insufficient_scope body to AuthorizationError with code', () => {
    const err = parseHttpError(403, {
      error: 'insufficient_scope',
      required: 'admin',
      missing: 'admin',
    });

    expect(err).toBeInstanceOf(AuthorizationError);
    expect(err.code).toBe('insufficient_scope');
    expect(err.message).toBe('insufficient_scope');
  });

  it('maps a 500 internal_server_error body to ServerError with code', () => {
    const err = parseHttpError(500, { error: 'internal_server_error' });

    expect(err).toBeInstanceOf(ServerError);
    expect(err.code).toBe('internal_server_error');
    expect(err.message).toBe('internal_server_error');
  });

  it('prefers an explicit message over the error code', () => {
    const err = parseHttpError(400, {
      error: 'validation_error',
      message: 'Request body is invalid',
    });

    expect(err.code).toBe('validation_error');
    expect(err.message).toBe('Request body is invalid');
  });
});
