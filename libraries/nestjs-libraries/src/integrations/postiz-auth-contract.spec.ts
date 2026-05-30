import {
  buildIntegrationAuthHealth,
  classifyPostizAuthError,
  enrichHttpExceptionBody,
  isPlatformOAuthMessage,
} from './postiz-auth-contract';

describe('postiz-auth-contract', () => {
  it('classifies LinkedIn revoked token as platform_oauth', () => {
    const result = classifyPostizAuthError({
      message: '{"serviceErrorCode":65601,"message":"REVOKED_ACCESS_TOKEN"}',
      httpStatus: 401,
      integrationId: 'int-1',
    });
    expect(result?.error_class).toBe('platform_oauth');
    expect(result?.error_code).toBe('REVOKED_ACCESS_TOKEN');
    expect(result?.integration_id).toBe('int-1');
  });

  it('classifies bare 401 as org_api_key', () => {
    const result = classifyPostizAuthError({
      message: 'Invalid API key',
      httpStatus: 401,
    });
    expect(result?.error_class).toBe('org_api_key');
    expect(result?.error_code).toBe('INVALID_ORG_API_KEY');
  });

  it('enriches exception bodies with structured fields', () => {
    const body = enrichHttpExceptionBody(
      { msg: 'REVOKED_ACCESS_TOKEN' },
      401,
      'int-x'
    );
    expect(body.error_class).toBe('platform_oauth');
    expect(body.msg).toBeTruthy();
    expect(body.http_status).toBe(401);
  });

  it('marks refreshNeeded integrations as needs_reconnect', () => {
    const health = buildIntegrationAuthHealth({
      id: 'i1',
      providerIdentifier: 'linkedin',
      token: 'tok',
      refreshNeeded: true,
      inBetweenSteps: false,
      disabled: false,
      tokenExpiration: new Date('2030-01-01'),
      updatedAt: new Date('2026-05-01'),
    });
    expect(health.status).toBe('needs_reconnect');
    expect(health.needs_reconnect).toBe(true);
    expect(health.last_error_code).toBe('REFRESH_TOKEN_FAILED');
  });

  it('marks telegram as non_oauth_provider when reconnect needed', () => {
    const health = buildIntegrationAuthHealth({
      id: 't1',
      providerIdentifier: 'telegram',
      token: '',
      refreshNeeded: false,
      inBetweenSteps: false,
      disabled: false,
    });
    expect(health.needs_reconnect).toBe(true);
    expect(health.reconnect_reason).toBe('non_oauth_provider');
  });

  it('detects oauth markers in nested JSON', () => {
    expect(
      isPlatformOAuthMessage('{"failure":{"message":"refresh_token failed"}}')
    ).toBe(true);
  });
});
