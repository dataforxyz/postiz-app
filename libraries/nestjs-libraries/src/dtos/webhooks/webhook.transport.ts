import https from 'node:https';
import { IncomingMessage } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import {
  normalizeWebhookUrl,
  redactWebhookDestination,
  resolveWebhookAddresses,
  WebhookDnsResolver,
} from './webhook.url.validator';

export type WebhookNetworkLimits = {
  dnsTimeoutMs: number;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  totalTimeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxResponseHeaderBytes: number;
};

export const WEBHOOK_NETWORK_LIMITS: Readonly<WebhookNetworkLimits> =
  Object.freeze({
    dnsTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    readTimeoutMs: 10_000,
    totalTimeoutMs: 15_000,
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 65_536,
    maxResponseHeaderBytes: 16_384,
  });

export type WebhookDeliveryError =
  | 'invalid_url'
  | 'blocked_destination'
  | 'dns_failure'
  | 'timeout'
  | 'payload_too_large'
  | 'connection_failure'
  | 'tls_failure'
  | 'redirect_not_allowed'
  | 'response_too_large'
  | 'http_error';

export type WebhookDeliveryResult = {
  ok: boolean;
  destination: string;
  status: number | null;
  error?: WebhookDeliveryError;
};

type RequestFunction = typeof https.request;
type AutoSelectRequestOptions = https.RequestOptions & {
  autoSelectFamily: boolean;
  autoSelectFamilyAttemptTimeout: number;
};

type WebhookTransportOptions = Partial<WebhookNetworkLimits> & {
  resolver?: WebhookDnsResolver;
  request?: RequestFunction;
};

function errorResult(
  destination: string,
  error: WebhookDeliveryError,
  status: number | null = null
): WebhookDeliveryResult {
  return { ok: false, destination, status, error };
}

function classifyNetworkError(
  error: NodeJS.ErrnoException
): WebhookDeliveryError {
  if (
    error.name === 'AbortError' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ESOCKETTIMEDOUT'
  ) {
    return 'timeout';
  }
  if (
    error.code?.startsWith('ERR_TLS') ||
    error.code === 'CERT_HAS_EXPIRED' ||
    error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return 'tls_failure';
  }
  return 'connection_failure';
}

export class WebhookTransport {
  private readonly resolver?: WebhookDnsResolver;
  private readonly request: RequestFunction;
  private readonly limits: Readonly<WebhookNetworkLimits>;

  constructor(options: WebhookTransportOptions = {}) {
    this.resolver = options.resolver;
    this.request = options.request || https.request;
    this.limits = {
      dnsTimeoutMs: options.dnsTimeoutMs ?? WEBHOOK_NETWORK_LIMITS.dnsTimeoutMs,
      connectTimeoutMs:
        options.connectTimeoutMs ?? WEBHOOK_NETWORK_LIMITS.connectTimeoutMs,
      readTimeoutMs:
        options.readTimeoutMs ?? WEBHOOK_NETWORK_LIMITS.readTimeoutMs,
      totalTimeoutMs:
        options.totalTimeoutMs ?? WEBHOOK_NETWORK_LIMITS.totalTimeoutMs,
      maxRequestBytes:
        options.maxRequestBytes ?? WEBHOOK_NETWORK_LIMITS.maxRequestBytes,
      maxResponseBytes:
        options.maxResponseBytes ?? WEBHOOK_NETWORK_LIMITS.maxResponseBytes,
      maxResponseHeaderBytes:
        options.maxResponseHeaderBytes ??
        WEBHOOK_NETWORK_LIMITS.maxResponseHeaderBytes,
    };
  }

  async sendJson(
    destination: string,
    payload: unknown
  ): Promise<WebhookDeliveryResult> {
    const startedAt = Date.now();
    let normalized: string;
    try {
      normalized = normalizeWebhookUrl(destination);
    } catch {
      return errorResult('invalid webhook destination', 'invalid_url');
    }

    const redactedDestination = redactWebhookDestination(normalized);
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return errorResult(redactedDestination, 'payload_too_large');
    }
    if (
      typeof body !== 'string' ||
      Buffer.byteLength(body) > this.limits.maxRequestBytes
    ) {
      return errorResult(redactedDestination, 'payload_too_large');
    }

    const parsed = new URL(normalized);
    let addresses;
    try {
      addresses = await resolveWebhookAddresses(
        parsed.hostname,
        this.resolver,
        this.limits.dnsTimeoutMs
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return errorResult(
        redactedDestination,
        message.startsWith('Blocked')
          ? 'blocked_destination'
          : message.includes('timeout')
          ? 'timeout'
          : 'dns_failure'
      );
    }

    const remainingTotalMs =
      this.limits.totalTimeoutMs - (Date.now() - startedAt);
    if (remainingTotalMs <= 0) {
      return errorResult(redactedDestination, 'timeout');
    }

    // DNS is resolved once per delivery. The request's pinned lookup can use
    // every validated answer for normal dual-stack connection fallback, but it
    // can never re-resolve the hostname or connect outside that checked set.
    return this.requestPinned(
      parsed,
      addresses,
      body,
      redactedDestination,
      remainingTotalMs
    );
  }

  private requestPinned(
    parsed: URL,
    addresses: ReadonlyArray<{ address: string; family: number }>,
    body: string,
    redactedDestination: string,
    totalTimeoutMs: number
  ): Promise<WebhookDeliveryResult> {
    return new Promise((resolve) => {
      let settled = false;
      let request: ReturnType<RequestFunction> | undefined;
      let response: IncomingMessage | undefined;
      let connectTimer: NodeJS.Timeout | undefined;
      let readTimer: NodeJS.Timeout | undefined;

      const finish = (result: WebhookDeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (connectTimer) clearTimeout(connectTimer);
        if (readTimer) clearTimeout(readTimer);
        resolve(result);
      };

      const abort = (
        error: WebhookDeliveryError,
        status: number | null = null
      ) => {
        finish(errorResult(redactedDestination, error, status));
        response?.destroy();
        request?.destroy();
      };

      const totalTimer = setTimeout(() => abort('timeout'), totalTimeoutMs);

      const resetReadTimer = (status: number | null) => {
        if (readTimer) clearTimeout(readTimer);
        readTimer = setTimeout(
          () => abort('timeout', status),
          this.limits.readTimeoutMs
        );
      };

      try {
        const authorityHostname = parsed.hostname.replace(/^\[|\]$/g, '');
        const requestOptions: AutoSelectRequestOptions = {
          protocol: 'https:',
          hostname: authorityHostname,
          port: parsed.port ? Number(parsed.port) : 443,
          method: 'POST',
          path: `${parsed.pathname}${parsed.search}`,
          lookup: (_hostname, options, callback) => {
            const lookupOptions =
              typeof options === 'number' ? { family: options } : options;
            const requestedFamily = lookupOptions?.family || 0;
            const candidates = requestedFamily
              ? addresses.filter(
                  (candidate) => candidate.family === requestedFamily
                )
              : addresses;
            if (!candidates.length) {
              callback(new Error('No validated address for family'), '', 0);
              return;
            }
            if (lookupOptions?.all) {
              callback(null, [...candidates] as any, 0);
              return;
            }
            callback(
              null,
              candidates[0].address,
              candidates[0].family as 4 | 6
            );
          },
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 250,
          servername: net.isIP(authorityHostname)
            ? undefined
            : authorityHostname,
          checkServerIdentity: (_hostname, certificate) =>
            tls.checkServerIdentity(authorityHostname, certificate),
          headers: {
            Host: parsed.host,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: '*/*',
          },
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: this.limits.maxResponseHeaderBytes,
        };
        request = this.request(requestOptions, (incoming) => {
          response = incoming;
          if (connectTimer) clearTimeout(connectTimer);
          const status = incoming.statusCode || null;
          let receivedBytes = 0;
          resetReadTimer(status);

          incoming.on('data', (chunk: Buffer | string) => {
            receivedBytes += Buffer.byteLength(chunk);
            if (receivedBytes > this.limits.maxResponseBytes) {
              abort('response_too_large', status);
              return;
            }
            resetReadTimer(status);
          });
          incoming.on('end', () => {
            if (status !== null && status >= 200 && status < 300) {
              finish({
                ok: true,
                destination: redactedDestination,
                status,
              });
            } else if (status !== null && status >= 300 && status < 400) {
              finish(
                errorResult(redactedDestination, 'redirect_not_allowed', status)
              );
            } else {
              finish(errorResult(redactedDestination, 'http_error', status));
            }
          });
          incoming.on('aborted', () => {
            if (!settled) abort('connection_failure', status);
          });
          incoming.on('error', (error: NodeJS.ErrnoException) => {
            if (!settled) abort(classifyNetworkError(error), status);
          });
        });

        connectTimer = setTimeout(
          () => abort('timeout'),
          this.limits.connectTimeoutMs
        );
        request.on('socket', (socket) => {
          if (!socket.connecting) {
            if (connectTimer) clearTimeout(connectTimer);
            return;
          }
          socket.once('secureConnect', () => {
            if (connectTimer) clearTimeout(connectTimer);
          });
        });
        request.on('error', (error: NodeJS.ErrnoException) => {
          if (!settled) abort(classifyNetworkError(error));
        });
        request.end(body);
      } catch (error) {
        abort(classifyNetworkError(error as NodeJS.ErrnoException));
      }
    });
  }
}

// Customer webhook delivery never consults DISABLE_SSRF_PROTECTION. That
// self-host integration escape hatch must not weaken hosted customer paths.
export const webhookTransport = new WebhookTransport();
