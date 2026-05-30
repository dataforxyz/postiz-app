import { HttpException } from '@nestjs/common';

/** Machine-readable auth failure classes for Juston and other API consumers. */
export type PostizAuthErrorClass =
  | 'platform_oauth'
  | 'org_api_key'
  | 'integration_missing'
  | 'transient';

export type IntegrationAuthStatus =
  | 'connected'
  | 'expiring_soon'
  | 'needs_reconnect'
  | 'unknown';

export interface PostizStructuredAuthError {
  error_code: string;
  error_class: PostizAuthErrorClass;
  message: string;
  http_status: number;
  integration_id?: string;
  /** Backward-compatible Postiz public API field. */
  msg: string;
  detail?: string;
}

export interface IntegrationAuthHealth {
  status: IntegrationAuthStatus;
  needs_reconnect: boolean;
  token_expires_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  /** Set for Telegram and other non-OAuth providers. */
  reconnect_reason?: 'non_oauth_provider' | 'refresh_failed' | 'token_expired';
}

const AUTH_MARKERS = [
  'revoked_access_token',
  'revoked access token',
  'token has been revoked',
  'invalid_access_token',
  'invalid access token',
  'expired_access_token',
  'expired access token',
  'invalid_grant',
  'error validating access token',
  'session has been invalidated',
  'refresh_token',
  '"type":"refresh_token"',
  'oauthexception',
  're-authorize',
  'reauthorize',
  'login expired',
  'token expired',
  'access token expired',
];

const CODE_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /\bREVOKED_ACCESS_TOKEN\b/i, code: 'REVOKED_ACCESS_TOKEN' },
  { re: /\bINVALID_ACCESS_TOKEN\b/i, code: 'INVALID_ACCESS_TOKEN' },
  { re: /\bEXPIRED_ACCESS_TOKEN\b/i, code: 'EXPIRED_ACCESS_TOKEN' },
  { re: /\bINVALID_GRANT\b/i, code: 'INVALID_GRANT' },
  { re: /"serviceErrorCode"\s*:\s*65601\b/, code: 'LINKEDIN_REVOKED' },
  { re: /"code"\s*:\s*"refresh_token"/i, code: 'REFRESH_TOKEN_FAILED' },
  { re: /"error_subcode"\s*:\s*463\b/, code: 'META_TOKEN_EXPIRED' },
  { re: /\berror_code["']?\s*[:=]\s*190\b/, code: 'META_OAUTH_190' },
];

const NON_OAUTH_PROVIDERS = new Set(['telegram']);

const EXPIRING_SOON_DAYS = 7;

function flattenMessage(raw: string): string {
  const parts = [raw];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      parts.push(JSON.stringify(parsed));
      for (const key of ['cause', 'failure', 'message', 'error', 'detail', 'errors']) {
        const val = (parsed as Record<string, unknown>)[key];
        if (typeof val === 'string') {
          parts.push(val);
        } else if (val) {
          parts.push(JSON.stringify(val));
        }
      }
    }
  } catch {
    // not JSON
  }
  return parts.join(' ').toLowerCase();
}

export function isPlatformOAuthMessage(message: string): boolean {
  if (!message?.trim()) {
    return false;
  }
  const blob = flattenMessage(message);
  if (AUTH_MARKERS.some((m) => blob.includes(m))) {
    return true;
  }
  return CODE_PATTERNS.some(({ re }) => re.test(message));
}

export function detectAuthErrorCode(message: string): string {
  for (const { re, code } of CODE_PATTERNS) {
    if (re.test(message)) {
      return code;
    }
  }
  if (isPlatformOAuthMessage(message)) {
    return 'PLATFORM_OAUTH_AUTH_FAILED';
  }
  return 'AUTH_FAILED';
}

export function classifyPostizAuthError(input: {
  message: string;
  httpStatus: number;
  integrationId?: string;
}): PostizStructuredAuthError | null {
  const message = (input.message || '').trim();
  const httpStatus = input.httpStatus;

  if (httpStatus === 401 && !isPlatformOAuthMessage(message)) {
    return {
      error_code: 'INVALID_ORG_API_KEY',
      error_class: 'org_api_key',
      message: message || 'Invalid or missing org API key',
      http_status: httpStatus,
      integration_id: input.integrationId,
      msg: message || 'Invalid API key',
    };
  }

  if (httpStatus === 404 && /integration/i.test(message)) {
    return {
      error_code: 'INTEGRATION_NOT_FOUND',
      error_class: 'integration_missing',
      message: message || 'Integration not found',
      http_status: httpStatus,
      integration_id: input.integrationId,
      msg: message || 'Integration not found',
    };
  }

  if (isPlatformOAuthMessage(message)) {
    return {
      error_code: detectAuthErrorCode(message),
      error_class: 'platform_oauth',
      message: message || 'Platform login expired or revoked',
      http_status: httpStatus || 401,
      integration_id: input.integrationId,
      msg: message || 'Platform login expired or revoked',
    };
  }

  if (httpStatus >= 500) {
    return {
      error_code: 'POSTIZ_TRANSIENT_ERROR',
      error_class: 'transient',
      message: message || 'Postiz temporary error',
      http_status: httpStatus,
      integration_id: input.integrationId,
      msg: message || 'Unexpected error',
    };
  }

  return null;
}

export function enrichHttpExceptionBody(
  body: Record<string, unknown> | string | undefined,
  httpStatus: number,
  integrationId?: string
): Record<string, unknown> {
  const base =
    typeof body === 'string'
      ? { msg: body, message: body }
      : body && typeof body === 'object'
        ? { ...body }
        : { msg: 'Error' };

  const message =
    String(
      base.message ?? base.msg ?? base.error ?? 'Error'
    ) || 'Error';

  const structured =
    (base.error_class && base.error_code
      ? null
      : classifyPostizAuthError({
          message,
          httpStatus,
          integrationId,
        })) || null;

  if (!structured) {
    return {
      ...base,
      msg: String(base.msg ?? message),
      http_status: httpStatus,
    };
  }

  return {
    ...base,
    ...structured,
    msg: structured.msg,
    detail: typeof body === 'string' ? body : base.detail ?? message,
  };
}

export function buildAuthHttpException(
  message: string,
  httpStatus: number,
  integrationId?: string
): HttpException {
  const body = enrichHttpExceptionBody({ msg: message, message }, httpStatus, integrationId);
  return new HttpException(body, httpStatus);
}

export function enrichPostErrorField(
  error: string | null | undefined,
  integrationId?: string
): string | Record<string, unknown> | null {
  if (!error?.trim()) {
    return error ?? null;
  }
  const structured = classifyPostizAuthError({
    message: error,
    httpStatus: 401,
    integrationId,
  });
  if (!structured || structured.error_class === 'transient') {
    return error;
  }
  return {
    raw: error,
    ...structured,
  };
}

type IntegrationHealthInput = {
  id: string;
  providerIdentifier: string;
  token?: string | null;
  refreshNeeded?: boolean;
  inBetweenSteps?: boolean;
  disabled?: boolean;
  tokenExpiration?: Date | string | null;
  updatedAt?: Date | string | null;
};

export function buildIntegrationAuthHealth(
  integration: IntegrationHealthInput
): IntegrationAuthHealth {
  const provider = (integration.providerIdentifier || '').toLowerCase();
  const tokenExpiresAt = integration.tokenExpiration
    ? new Date(integration.tokenExpiration)
  : null;
  const updatedAt = integration.updatedAt
    ? new Date(integration.updatedAt)
    : null;

  const nonOauth = NON_OAUTH_PROVIDERS.has(provider);
  const missingToken = !integration.token?.trim();
  const refreshFailed = !!integration.refreshNeeded;
  const midConnect = !!integration.inBetweenSteps;

  let needsReconnect = refreshFailed || missingToken || !!integration.disabled;
  let reconnectReason: IntegrationAuthHealth['reconnect_reason'] | undefined;

  if (nonOauth) {
    if (needsReconnect || midConnect) {
      reconnectReason = 'non_oauth_provider';
      needsReconnect = true;
    }
  } else if (refreshFailed) {
    reconnectReason = 'refresh_failed';
  } else if (missingToken) {
    reconnectReason = 'token_expired';
  }

  if (midConnect && !nonOauth) {
    return {
      status: 'unknown',
      needs_reconnect: false,
      token_expires_at: tokenExpiresAt?.toISOString() ?? null,
      last_success_at: updatedAt?.toISOString() ?? null,
      last_error_code: null,
    };
  }

  if (needsReconnect) {
    return {
      status: 'needs_reconnect',
      needs_reconnect: true,
      token_expires_at: tokenExpiresAt?.toISOString() ?? null,
      last_success_at: updatedAt?.toISOString() ?? null,
      last_error_code: refreshFailed ? 'REFRESH_TOKEN_FAILED' : null,
      reconnect_reason: reconnectReason,
    };
  }

  const soon = new Date();
  soon.setDate(soon.getDate() + EXPIRING_SOON_DAYS);
  if (tokenExpiresAt && tokenExpiresAt <= soon) {
    return {
      status: 'expiring_soon',
      needs_reconnect: false,
      token_expires_at: tokenExpiresAt.toISOString(),
      last_success_at: updatedAt?.toISOString() ?? null,
      last_error_code: null,
    };
  }

  return {
    status: 'connected',
    needs_reconnect: false,
    token_expires_at: tokenExpiresAt?.toISOString() ?? null,
    last_success_at: updatedAt?.toISOString() ?? null,
    last_error_code: null,
  };
}
