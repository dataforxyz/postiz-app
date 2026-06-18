import { AuthService } from '@gitroom/helpers/auth/auth.service';

export const POSTIZ_CALLBACK_ISSUER = 'postiz';
export const POSTIZ_CALLBACK_AUDIENCE = 'juston';
export const POSTIZ_CALLBACK_TTL_SECONDS = 300;

type PostizCallbackJwtInput = {
  apiKey: string;
  jti: string;
  nowSeconds?: number;
};

export function createPostizCallbackJwt({
  apiKey,
  jti,
  nowSeconds = Math.floor(Date.now() / 1000),
}: PostizCallbackJwtInput) {
  if (!jti) {
    throw new Error('Postiz callback JWT requires a jti');
  }

  return AuthService.signJWT({
    apiKey,
    iss: POSTIZ_CALLBACK_ISSUER,
    aud: POSTIZ_CALLBACK_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + POSTIZ_CALLBACK_TTL_SECONDS,
    jti,
  });
}
