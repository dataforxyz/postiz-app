import { TiktokProvider } from './tiktok.provider';

const ORIGINAL_ENV = process.env;

function authScopes(url: string) {
  const encodedScopes = new URL(url).searchParams.get('scope');
  return encodedScopes?.split(',') ?? [];
}

function jsonResponse(body: unknown) {
  return {
    json: async () => body,
  } as Response;
}

describe('TiktokProvider OAuth scopes', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      FRONTEND_URL: 'https://postiz.example',
      TIKTOK_CLIENT_ID: 'client-id',
      TIKTOK_CLIENT_SECRET: 'client-secret',
    };
    delete process.env.TIKTOK_OAUTH_SCOPES;
    jest.restoreAllMocks();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it('uses a minimal posting scope list by default', async () => {
    const provider = new TiktokProvider();

    const auth = await provider.generateAuthUrl();

    expect(authScopes(auth.url)).toEqual([
      'user.info.basic',
      'video.upload',
      'video.publish',
    ]);
    expect(auth.url).not.toContain('video.list');
    expect(auth.url).not.toContain('user.info.profile');
    expect(auth.url).not.toContain('user.info.stats');
  });

  it('parses configured scopes with comma or space separators and de-duplicates them', async () => {
    process.env.TIKTOK_OAUTH_SCOPES =
      ' user.info.basic video.upload,video.publish user.info.profile user.info.profile ';
    const provider = new TiktokProvider();

    const auth = await provider.generateAuthUrl();

    expect(authScopes(auth.url)).toEqual([
      'user.info.basic',
      'video.upload',
      'video.publish',
      'user.info.profile',
    ]);
  });

  it('disables optional TikTok read features when read scopes are not configured', async () => {
    const provider = new TiktokProvider();
    const fetchSpy = jest.spyOn(provider, 'fetch');

    await expect(
      provider.analytics('integration-id', 'access-token', 0)
    ).resolves.toEqual([]);
    await expect(
      provider.missing('integration-id', 'access-token')
    ).resolves.toEqual([]);
    await expect(
      provider.postAnalytics('integration-id', 'access-token', 'video-id', 0)
    ).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps TikTok analytics reads available when optional read scopes are configured', async () => {
    process.env.TIKTOK_OAUTH_SCOPES =
      'user.info.basic,video.upload,video.publish,user.info.stats,video.list';
    const provider = new TiktokProvider();
    const fetchSpy = jest
      .spyOn(provider, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            user: {
              follower_count: 10,
              following_count: 5,
              likes_count: 20,
              video_count: 2,
            },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            videos: [{ id: 'video-1' }],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            videos: [
              {
                id: 'video-1',
                like_count: 7,
                comment_count: 3,
                share_count: 2,
                view_count: 50,
              },
            ],
          },
        })
      );

    const result = await provider.analytics(
      'integration-id',
      'access-token',
      0
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/user/info/');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/video/list/');
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/video/query/');
    expect(result.map((entry) => entry.label)).toEqual([
      'Followers',
      'Following',
      'Total Likes',
      'Videos',
      'Views',
      'Recent Likes',
      'Recent Comments',
      'Recent Shares',
    ]);
  });

  it('validates callback scopes against the same resolved scope list', async () => {
    const provider = new TiktokProvider();
    const checkScopes = jest.spyOn(provider, 'checkScopes');
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'user.info.basic,video.upload,video.publish',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            user: {
              avatar_url: 'https://avatar.example/tiktok.png',
              display_name: 'Tik User',
              open_id: 'open-id',
            },
          },
        })
      );

    const result = await provider.authenticate({
      code: 'code',
      codeVerifier: 'verifier',
    });

    expect(checkScopes).toHaveBeenCalledWith(
      ['user.info.basic', 'video.upload', 'video.publish'],
      'user.info.basic,video.upload,video.publish'
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'fields=open_id,avatar_url,display_name,union_id'
    );
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('username');
    expect(result).toMatchObject({
      id: 'openid',
      name: 'Tik User',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(result.username).toBeUndefined();
  });

  it('requests username only when the profile scope is configured', async () => {
    process.env.TIKTOK_OAUTH_SCOPES =
      'user.info.basic,video.upload,video.publish,user.info.profile';
    const provider = new TiktokProvider();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'user.info.basic,video.upload,video.publish,user.info.profile',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            user: {
              avatar_url: 'https://avatar.example/tiktok.png',
              display_name: 'Tik User',
              open_id: 'open-id',
              username: 'tikuser',
            },
          },
        })
      );

    const result = await provider.authenticate({
      code: 'code',
      codeVerifier: 'verifier',
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain('username');
    expect(result.username).toBe('tikuser');
  });

  it('rejects callback scopes missing a configured requested scope', () => {
    process.env.TIKTOK_OAUTH_SCOPES =
      'user.info.basic,video.upload,video.publish,user.info.profile';
    const provider = new TiktokProvider();

    let thrown: unknown;
    try {
      provider.checkScopes(
        provider.scopes,
        'user.info.basic,video.upload,video.publish'
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      message:
        'Not enough scopes, when choosing a provider, please add all the scopes',
    });
  });

  it('resolves first-party local upload URLs to local files for chunked uploads', () => {
    process.env.FRONTEND_URL = 'https://postiz.example';
    process.env.UPLOAD_DIRECTORY = '/uploads';
    const provider = new TiktokProvider();

    expect(
      (provider as any).tiktokLocalUploadPath(
        'https://postiz.example/uploads/2026/07/02/video.mp4'
      )
    ).toBe('/uploads/2026/07/02/video.mp4');
  });

  it('uses HEAD content-length for remote TikTok media size', async () => {
    const provider = new TiktokProvider();
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'content-length': '123456' },
      })
    );

    await expect(
      (provider as any).tiktokMediaSize('https://media.example/video.mp4')
    ).resolves.toBe(123456);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });

  it('falls back to a one-byte range GET when presigned HEAD is rejected', async () => {
    const provider = new TiktokProvider();
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'content-length': '219' },
        })
      )
      .mockResolvedValueOnce({
        status: 206,
        headers: new Headers({
          'content-length': '1',
          'content-range': 'bytes 0-0/987654',
        }),
        body: { cancel },
      } as any);

    await expect(
      (provider as any).tiktokMediaSize('https://media.example/video.mp4')
    ).resolves.toBe(987654);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Range: 'bytes=0-0' },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects remote TikTok media without valid HEAD or range size metadata', async () => {
    const provider = new TiktokProvider();
    const cancel = jest.fn().mockResolvedValue(undefined);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ 'content-length': '1' }),
        body: { cancel },
      } as any);

    await expect(
      (provider as any).tiktokMediaSize('https://media.example/video.mp4')
    ).rejects.toMatchObject({
      message: 'Could not determine the video size for TikTok upload',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [64 * 1024 * 1024, 64 * 1024 * 1024, 1],
    [65 * 1024 * 1024, Math.ceil((65 * 1024 * 1024) / 2), 2],
    [75_064_653, Math.ceil(75_064_653 / 2), 2],
    [128 * 1024 * 1024, 64 * 1024 * 1024, 2],
    [128 * 1024 * 1024 + 1, Math.ceil((128 * 1024 * 1024 + 1) / 3), 3],
  ])(
    'plans valid balanced chunks for %i bytes',
    (videoSize, chunkSize, totalChunkCount) => {
      const provider = new TiktokProvider();
      const plan = (provider as any).tiktokChunkPlan(videoSize);

      expect(plan).toEqual({ chunkSize, totalChunkCount });
      const finalChunkSize = videoSize - chunkSize * (totalChunkCount - 1);
      expect(chunkSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      expect(chunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(finalChunkSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      expect(finalChunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
    }
  );
});
