import {
  isBlockedIp,
  normalizeWebhookUrl,
  redactWebhookDestination,
} from './webhook.url.validator';

describe('webhook URL validation', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.2',
    '203.0.113.4',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '100::1',
    '2001:db8::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('blocks special address %s', (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => {
      expect(isBlockedIp(address)).toBe(false);
    }
  );

  it.each([
    'http://example.com/hook',
    'ftp://example.com/hook',
    'https://user:secret@example.com/hook',
    'https://example.com/hook#secret',
    'https://example.com\\@127.0.0.1/hook',
    'https://example.com/hook\nHost: 127.0.0.1',
    'https://example.com/%2fadmin',
    'https://example.com/%252fadmin',
    'https://example.com/%2e%2e/admin',
    'https://example.com/%252e%252e/admin',
    'https://127.1/hook',
    'https://0x7f000001/hook',
    'https://2130706433/hook',
    'https://[::ffff:7f00:1]/hook',
  ])('rejects unsafe or ambiguous URL %s', (url) => {
    expect(() => normalizeWebhookUrl(url)).toThrow();
  });

  it('normalizes a valid public HTTPS URL without breaking encoded query secrets', () => {
    expect(
      normalizeWebhookUrl(
        'https://EXAMPLE.com:443/hooks/events?signature=a%2Fb%3D'
      )
    ).toBe('https://example.com/hooks/events?signature=a%2Fb%3D');
  });

  it('redacts paths and query strings to the destination origin', () => {
    expect(
      redactWebhookDestination(
        'https://hooks.example.com/customer/secret?token=also-secret'
      )
    ).toBe('https://hooks.example.com');
  });
});
