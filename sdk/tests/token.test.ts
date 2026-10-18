import { describe, it, expect } from 'vitest';
import { validateSacTokenAddress } from '../src/token';
import { ValidationError } from '../src/errors';

describe('validateSacTokenAddress', () => {
  it('throws a ValidationError with a contractId field for an invalid address', () => {
    let caught: unknown;
    try {
      validateSacTokenAddress('nope');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.fields).toBeDefined();
    expect(err.fields?.contractId).toBe(
      'Must be a valid contract address (C-address), got: nope',
    );
  });
});
