import { ForbiddenException } from '@nestjs/common';
import { ScopeGuard } from './scope.guard';

describe('ScopeGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };

  let guard: ScopeGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ScopeGuard(reflector as any);
  });

  it('allows legacy tokens with no scopes', () => {
    reflector.getAllAndOverride.mockReturnValue('write');

    const canActivate = guard.canActivate({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
          getRequest: () => ({
          tokenScopes: null as any,
          }),
      }),
    } as any);

    expect(canActivate).toBe(true);
  });

  it('rejects writes for read-only scoped tokens', () => {
    reflector.getAllAndOverride.mockReturnValue('write');

    expect(() =>
      guard.canActivate({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({
            tokenScopes: {
              permissions: ['read'],
              integrationIds: ['integration-a'],
            },
          }),
        }),
      } as any)
    ).toThrow(ForbiddenException);
  });

  it('allows reads for read-only scoped tokens', () => {
    reflector.getAllAndOverride.mockReturnValue('read');

    const canActivate = guard.canActivate({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          tokenScopes: {
            permissions: ['read'],
            integrationIds: ['integration-a'],
          },
        }),
      }),
    } as any);

    expect(canActivate).toBe(true);
  });
});
