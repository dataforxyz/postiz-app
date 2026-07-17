import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';

const MAX_WEBHOOK_URL_LENGTH = 2_048;
const DNS_TIMEOUT_MS = 5_000;

const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 (current network)
  [0x0a000000, 8], // 10.0.0.0/8 (private)
  [0x64400000, 10], // 100.64.0.0/10 (shared address space)
  [0x7f000000, 8], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local and metadata)
  [0xac100000, 12], // 172.16.0.0/12 (private)
  [0xc0000000, 24], // 192.0.0.0/24 (IETF protocol assignments)
  [0xc0000200, 24], // 192.0.2.0/24 (documentation)
  [0xc0586300, 24], // 192.88.99.0/24 (deprecated 6to4 relay)
  [0xc0a80000, 16], // 192.168.0.0/16 (private)
  [0xc6120000, 15], // 198.18.0.0/15 (benchmarking)
  [0xc6336400, 24], // 198.51.100.0/24 (documentation)
  [0xcb007100, 24], // 203.0.113.0/24 (documentation)
  [0xe0000000, 4], // 224.0.0.0/4 (multicast)
  [0xf0000000, 4], // 240.0.0.0/4 (reserved/broadcast)
];

const BLOCKED_IPV6_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6ToBigInt('::'), 128], // unspecified
  [ipv6ToBigInt('::1'), 128], // loopback
  [ipv6ToBigInt('64:ff9b::'), 96], // IPv4/IPv6 translation
  [ipv6ToBigInt('64:ff9b:1::'), 48], // local-use translation
  [ipv6ToBigInt('100::'), 64], // discard-only
  [ipv6ToBigInt('2001::'), 23], // IETF special-purpose space
  [ipv6ToBigInt('2001:db8::'), 32], // documentation
  [ipv6ToBigInt('2002::'), 16], // deprecated 6to4
  [ipv6ToBigInt('3fff::'), 20], // documentation
  [ipv6ToBigInt('5f00::'), 16], // segment-routing SIDs
  [ipv6ToBigInt('fc00::'), 7], // unique-local
  [ipv6ToBigInt('fe80::'), 10], // link-local
  [ipv6ToBigInt('fec0::'), 10], // deprecated site-local/reserved
  [ipv6ToBigInt('ff00::'), 8], // multicast
];

export type WebhookDnsRecord = { address: string; family: number };
export type WebhookDnsResolver = (
  hostname: string
) => Promise<ReadonlyArray<WebhookDnsRecord>>;

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip: string): bigint {
  let value = ip.toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = ipv4ToNumber(value.slice(lastColon + 1));
    if (ipv4 === undefined) throw new Error('Invalid IPv4-mapped IPv6 address');
    value = `${value.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(
      16
    )}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) throw new Error('Invalid IPv6 address');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new Error('Invalid IPv6 address');
  }

  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) throw new Error('Invalid IPv6 address');

  return groups.reduce((result, group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      throw new Error('Invalid IPv6 address');
    }
    return (result << BigInt(16)) | BigInt(parseInt(group, 16));
  }, BigInt(0));
}

function isInIpv4Cidr(value: number, network: number, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function isInIpv6Cidr(value: bigint, network: bigint, prefix: number) {
  const shift = BigInt(128 - prefix);
  return value >> shift === network >> shift;
}

export function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === undefined) return true;
  return BLOCKED_IPV4_RANGES.some(([network, prefix]) =>
    isInIpv4Cidr(value, network, prefix)
  );
}

export function isBlockedIPv6(ip: string): boolean {
  let value: bigint;
  try {
    value = ipv6ToBigInt(ip);
  } catch {
    return true;
  }

  // IPv4-mapped IPv6 has the first 80 bits zero and the next 16 bits set.
  if (value >> BigInt(32) === BigInt(0xffff)) {
    const ipv4 = Number(value & BigInt(0xffffffff)) >>> 0;
    return BLOCKED_IPV4_RANGES.some(([network, prefix]) =>
      isInIpv4Cidr(ipv4, network, prefix)
    );
  }

  // Deprecated IPv4-compatible addresses can reach IPv4 destinations too.
  if (value >> BigInt(32) === BigInt(0)) return true;

  return BLOCKED_IPV6_RANGES.some(([network, prefix]) =>
    isInIpv6Cidr(value, network, prefix)
  );
}

export function isBlockedIp(ip: string): boolean {
  const unwrapped = ip.replace(/^\[|\]$/g, '');
  const version = net.isIP(unwrapped);
  if (version === 4) return isBlockedIPv4(unwrapped);
  if (version === 6) return isBlockedIPv6(unwrapped);
  return true;
}

function containsAmbiguousPath(value: string) {
  const authorityStart = value.indexOf('://') + 3;
  const pathStart = value.indexOf('/', authorityStart);
  if (pathStart === -1) return false;
  const rawPath = value.slice(pathStart).split(/[?#]/, 1)[0];

  // Reject delimiters, dot segments, controls, and percent signs after one
  // decode. %25 also prevents double-encoded path delimiters. Query values
  // remain compatible with providers that require percent-encoded secrets.
  return (
    /%(?:00|09|0a|0d|23|25|2e|2f|3f|5c)/i.test(rawPath) ||
    /(^|\/)\.{1,2}(\/|$)/.test(rawPath)
  );
}

export function normalizeWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('Invalid webhook URL');
  }
  if (
    value.length > MAX_WEBHOOK_URL_LENGTH ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Invalid webhook URL');
  }
  if (containsAmbiguousPath(value)) {
    throw new Error('Invalid webhook URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error('Invalid webhook URL');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.') ||
    hostname.includes('%')
  ) {
    throw new Error('Invalid webhook URL');
  }

  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    throw new Error('Blocked webhook destination');
  }

  // URL supplies the canonical host, default-port, IDN, and path form that is
  // persisted and later sent. It never preserves credentials or fragments.
  return parsed.href;
}

export const defaultWebhookDnsResolver: WebhookDnsResolver = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

export async function resolveWebhookAddresses(
  hostname: string,
  resolver: WebhookDnsResolver = defaultWebhookDnsResolver,
  timeoutMs = DNS_TIMEOUT_MS
): Promise<ReadonlyArray<WebhookDnsRecord>> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isBlockedIp(literal)) throw new Error('Blocked webhook destination');
    return [{ address: literal, family: net.isIP(literal) }];
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolver(literal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs);
      }),
    ]);
    if (
      !records.length ||
      records.some((record) => isBlockedIp(record.address))
    ) {
      throw new Error('Blocked webhook destination');
    }
    return records;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function isSafePublicHttpsUrl(value: unknown): Promise<boolean> {
  try {
    const normalized = normalizeWebhookUrl(value);
    const parsed = new URL(normalized);
    await resolveWebhookAddresses(parsed.hostname);
    return true;
  } catch {
    return false;
  }
}

export function redactWebhookDestination(value: string): string {
  try {
    return new URL(normalizeWebhookUrl(value)).origin;
  } catch {
    return 'invalid webhook destination';
  }
}

@ValidatorConstraint({ name: 'IsSafeWebhookUrl', async: true })
export class IsSafeWebhookUrlConstraint
  implements ValidatorConstraintInterface
{
  async validate(value: unknown, _args: ValidationArguments): Promise<boolean> {
    return isSafePublicHttpsUrl(value);
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'URL must be a canonical public HTTPS URL';
  }
}

export function IsSafeWebhookUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsSafeWebhookUrlConstraint,
    });
  };
}
