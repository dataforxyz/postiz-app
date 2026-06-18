import { verify } from 'jsonwebtoken';
import {
  createPostizCallbackJwt,
  POSTIZ_CALLBACK_AUDIENCE,
  POSTIZ_CALLBACK_ISSUER,
  POSTIZ_CALLBACK_TTL_SECONDS,
} from './postiz.callback-jwt';

describe('createPostizCallbackJwt', () => {
  const jwtSecret = 'test-postiz-callback-secret';

  beforeEach(() => {
    process.env.JWT_SECRET = jwtSecret;
  });

  it('signs callback JWTs with standard claims and stable jti', () => {
    const nowSeconds = 1_700_000_000;
    const token = createPostizCallbackJwt({
      apiKey: 'pst_test_key',
      jti: 'oauth-complete-event-123',
      nowSeconds,
    });

    const decoded = verify(token, jwtSecret, {
      issuer: POSTIZ_CALLBACK_ISSUER,
      audience: POSTIZ_CALLBACK_AUDIENCE,
      clockTimestamp: nowSeconds,
    }) as Record<string, unknown>;

    expect(decoded).toEqual(
      expect.objectContaining({
        apiKey: 'pst_test_key',
        iss: 'postiz',
        aud: 'juston',
        iat: nowSeconds,
        exp: nowSeconds + POSTIZ_CALLBACK_TTL_SECONDS,
        jti: 'oauth-complete-event-123',
      })
    );
  });

  it('requires a jti', () => {
    expect(() =>
      createPostizCallbackJwt({ apiKey: 'pst_test_key', jti: '' })
    ).toThrow('jti');
  });
});
