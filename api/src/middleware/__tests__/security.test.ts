import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { parameterPollutionProtection } from '../security';

describe('parameterPollutionProtection', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      ip: '127.0.0.1',
      path: '/api/v1/transactions',
      query: {},
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
  });

  it('allows single-valued scalar parameters', () => {
    mockReq.query = { limit: '10', offset: '0' };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('allows repeated multi-valued parameters like status', () => {
    mockReq.query = { status: ['pending', 'completed'] };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('allows repeated multi-valued parameters like type', () => {
    mockReq.query = { type: ['transfer', 'deposit'] };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('rejects repeated non-whitelisted scalar parameters', () => {
    mockReq.query = { limit: ['10', '20'] };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'duplicate_query_parameters',
      message: 'duplicate query parameters are not allowed',
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('rejects repeated duplicated offset parameter', () => {
    mockReq.query = { offset: ['0', '10'] };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('allows mix of scalar and multi-valued whitelisted parameters', () => {
    mockReq.query = { limit: '10', status: ['pending', 'completed'] };
    parameterPollutionProtection(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });
});
