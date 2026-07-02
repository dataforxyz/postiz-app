import 'reflect-metadata';

import { YoutubeProvider } from './youtube.provider';

const EXPECTED_YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const BROAD_YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtubepartner',
];

const ORIGINAL_ENV = process.env;

function authScopes(url: string) {
  const encodedScopes = new URL(url).searchParams.get('scope');
  return encodedScopes?.split(' ') ?? [];
}

describe('YoutubeProvider OAuth scopes', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      FRONTEND_URL: 'https://postiz.example',
      YOUTUBE_CLIENT_ID: 'client-id',
      YOUTUBE_CLIENT_SECRET: 'client-secret',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('requests only the YouTube scopes needed for channel connection, uploads, and analytics reads', async () => {
    const provider = new YoutubeProvider();

    expect(provider.scopes).toEqual(EXPECTED_YOUTUBE_SCOPES);
    BROAD_YOUTUBE_SCOPES.forEach((scope) => {
      expect(provider.scopes).not.toContain(scope);
    });

    const auth = await provider.generateAuthUrl();
    const scopes = authScopes(auth.url);

    expect(scopes).toEqual(EXPECTED_YOUTUBE_SCOPES);
    BROAD_YOUTUBE_SCOPES.forEach((scope) => {
      expect(scopes).not.toContain(scope);
    });
  });
});
