import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { WordpressDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/wordpress.dto';
import slugify from 'slugify';
// import FormData from 'form-data';
import axios from 'axios';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { readFileSync } from 'fs';
import { join, normalize } from 'node:path';
import { IntegrationCapabilities } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.capabilities';

export class WordpressProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'wordpress';
  name = 'WordPress';
  isBetweenSteps = false;
  editor = 'html' as const;
  scopes = [] as string[];
  override maxConcurrentJob = 5; // WordPress self-hosted typically has generous limits
  dto = WordpressDto;
  maxLength() {
    return 100000;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }
  override handleErrors(
    body: string
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    if (body.indexOf('rest_cannot_create') > -1) {
      return {
        type: 'bad-body',
        value: 'The connect user has insufficient permissions to create posts',
      };
    }
    return undefined;
  }

  async customFields() {
    return [
      {
        key: 'domain',
        label: 'Domain URL',
        validation: `/^https?:\\/\\/(?:www\\.)?[\\w\\-]+(\\.[\\w\\-]+)+([\\/?#][^\\s]*)?$/`,
        type: 'text' as const,
      },
      {
        key: 'username',
        label: 'Username',
        validation: `/.+/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        label: 'Password',
        validation: `/.+/`,
        type: 'password' as const,
        hint: 'Application password, create in User->Profile',
      },
    ];
  }

  private trimTrailingSlashes(value: string) {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
      end -= 1;
    }
    return value.slice(0, end);
  }

  private normalizeDomain(rawDomain: string) {
    let parsed: URL;
    try {
      parsed = new URL(rawDomain.trim());
    } catch {
      return undefined;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }

    if (parsed.username || parsed.password || !parsed.hostname) {
      return undefined;
    }

    parsed.hash = '';
    parsed.search = '';
    while (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  }

  private wordpressUrl(domain: string, path: string) {
    const base = domain.endsWith('/') ? domain : `${domain}/`;
    const relativePath = path.startsWith('/') ? path.slice(1) : path;
    return new URL(relativePath, base).toString();
  }

  private async safeWordpressDomain(rawDomain: string) {
    const domain = this.normalizeDomain(rawDomain);
    if (!domain) {
      return undefined;
    }

    // Self-hosted deployments can opt out of the public-HTTPS check when they
    // intentionally connect to an internal WordPress over a private network.
    // The hosted/default path requires a public HTTPS target and still uses the
    // undici dispatcher below to pin DNS and block private IP redirects/rebinds.
    if (process.env.DISABLE_SSRF_PROTECTION === 'true') {
      return domain;
    }

    return (await isSafePublicHttpsUrl(
      this.wordpressUrl(domain, '/wp-json/wp/v2/users/me')
    ))
      ? domain
      : undefined;
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = JSON.parse(Buffer.from(params.code, 'base64').toString()) as {
      domain: string;
      username: string;
      password: string;
    };

    // Normalize and validate the domain before using it in a server-side
    // request. Users often paste it with surrounding whitespace or a trailing
    // slash, which would otherwise build `https://site.com//wp-json/...`.
    const domain = await this.safeWordpressDomain(body.domain);
    if (!domain) {
      return 'Domain URL must be a publicly reachable HTTPS WordPress site.';
    }

    const auth = Buffer.from(`${body.username}:${body.password}`).toString(
      'base64'
    );

    // Direct fetch (not `this.fetch`) so we can branch on the HTTP status and
    // return a specific message instead of throwing a generic error.
    let response: Response;
    try {
      // lgtm[js/request-forgery] The WordPress domain was normalized and checked by safeWordpressDomain above; the dispatcher pins DNS and blocks private IPs.
      response = await fetch(this.wordpressUrl(domain, '/wp-json/wp/v2/users/me'), {
        headers: {
          Authorization: `Basic ${auth}`,
        },
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
      });
    } catch (err) {
      // DNS failure, connection refused, TLS error, site unreachable, etc.
      console.log(err);
      return 'Could not reach your WordPress site. Check the Domain URL and that the site is publicly accessible.';
    }

    // A security plugin (e.g. Wordfence), a WAF, or the server config commonly
    // strips the Authorization header or locks down the REST API. We don't try
    // to work around that - surface a distinct, actionable message instead.
    if (!response.ok) {
      // Log what WordPress actually returned (REST errors carry a `code` and
      // `message`) so failures can be diagnosed without guessing.
      const errorBody = await response.text().catch(() => '');
      let wpCode = '';
      let wpMessage = '';
      try {
        const parsed = JSON.parse(errorBody);
        wpCode = parsed?.code || '';
        wpMessage = parsed?.message || '';
      } catch (err) {
        // Non-JSON error body (e.g. an HTML page from a security plugin).
      }
      console.log(
        'WordPress auth failed',
        JSON.stringify({
          domain,
          status: response.status,
          code: wpCode,
          message: wpMessage,
          ...(wpCode ? {} : { body: errorBody.slice(0, 500) }),
        })
      );

      if (response.status === 401 || response.status === 403) {
        return 'WordPress rejected the login. A security plugin or server setting may be blocking the REST API or stripping the Authorization header, or the username / Application Password is incorrect.';
      }

      return `WordPress returned an unexpected error (HTTP ${response.status}). Make sure the REST API is enabled and Application Passwords are available.`;
    }

    // Even on a 200, a security plugin / maintenance page can return HTML
    // instead of JSON, which would otherwise throw on `.json()`.
    let data: any;
    try {
      data = await response.json();
    } catch (err) {
      console.log(err);
      return 'WordPress did not return a valid response. The REST API may be disabled or blocked by a security plugin.';
    }

    const { id, name, avatar_urls, code } = data || {};

    if (code) {
      return 'Invalid credentials';
    }

    const biggestImage = Object.entries(avatar_urls || {}).reduce(
      (all, current) => {
        if (all > Number(current[0])) {
          return all;
        }
        return Number(current[0]);
      },
      0
    );

    return {
      refreshToken: '',
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: Buffer.from(
        JSON.stringify({
          ...body,
          domain,
        })
      ).toString('base64'),
      id: domain + '_' + id,
      name,
      picture: avatar_urls?.[String(biggestImage)] || '',
      username: body.username,
    };
  }

  // Custom provider functions below are invoked from the backend HTTP endpoint
  // (`/integrations/function`) - which is NOT a Temporal activity - so they must
  // use a plain `fetch` (with the SSRF guard) rather than `this.fetch`, which
  // calls `Context.current()` and throws outside an activity. This mirrors how
  // `authenticate` issues its request.
  private async wpGet(token: string, path: string) {
    const body = JSON.parse(Buffer.from(token, 'base64').toString()) as {
      domain: string;
      username: string;
      password: string;
    };

    const auth = Buffer.from(`${body.username}:${body.password}`).toString(
      'base64'
    );

    const domain = await this.safeWordpressDomain(body.domain);
    if (!domain) {
      throw new Error('Invalid WordPress domain');
    }

    // lgtm[js/request-forgery] The WordPress domain was normalized and checked by safeWordpressDomain above; the dispatcher pins DNS and blocks private IPs.
    const response = await fetch(this.wordpressUrl(domain, path), {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      // @ts-ignore - undici-only option; blocks SSRF to internal IPs
      dispatcher: getSsrfSafeDispatcher(),
    });

    return response.json();
  }

  private localUploadPath(fileUrl: string) {
    const frontendUrl = process.env.FRONTEND_URL
      ? this.trimTrailingSlashes(process.env.FRONTEND_URL)
      : undefined;
    const uploadDirectory = process.env.UPLOAD_DIRECTORY;
    if (!frontendUrl || !uploadDirectory) {
      return null;
    }

    const localUploadsUrl = `${frontendUrl}/uploads/`;
    if (!fileUrl.startsWith(localUploadsUrl)) {
      return null;
    }

    const uploadPrefix = '/uploads/';
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const publicPath = pathname.startsWith(uploadPrefix)
      ? pathname.slice(uploadPrefix.length)
      : pathname;
    const uploadRoot = normalize(uploadDirectory);
    const resolvedPath = normalize(join(uploadRoot, publicPath));
    const uploadRootWithSlash = uploadRoot.endsWith('/')
      ? uploadRoot
      : `${uploadRoot}/`;

    return resolvedPath.startsWith(uploadRootWithSlash) ? resolvedPath : null;
  }

  private async mediaBlob(fileUrl: string) {
    const localFilePath = this.localUploadPath(fileUrl);
    if (localFilePath) {
      const extension = localFilePath.split('.').pop()?.toLowerCase();
      const mimeType =
        extension === 'png'
          ? 'image/png'
          : extension === 'webp'
          ? 'image/webp'
          : extension === 'gif'
          ? 'image/gif'
          : 'image/jpeg';
      return new Blob([readFileSync(localFilePath)], { type: mimeType });
    }

    return this.fetch(fileUrl).then((r) => r.blob());
  }

  @Tool({
    description: 'Get list of post types',
    dataSchema: [],
  })
  async postTypes(token: string) {
    const postTypes = await this.wpGet(token, '/wp-json/wp/v2/types');

    return Object.entries<any>(postTypes).reduce((all, [key, value]) => {
      if (
        key.indexOf('wp_') > -1 ||
        key.indexOf('nav_') > -1 ||
        key === 'attachment'
      ) {
        return all;
      }

      all.push({
        id: value.rest_base,
        name: value.name,
      });

      return all;
    }, []);
  }

  @Tool({
    description: 'Get list of categories',
    dataSchema: [],
  })
  async categoriesList(token: string) {
    const categories = await this.wpGet(
      token,
      '/wp-json/wp/v2/categories?per_page=100'
    );

    return (Array.isArray(categories) ? categories : []).map(
      (category: any) => ({
        id: category.id,
        name: category.name,
      })
    );
  }

  @Tool({
    description: 'Get list of tags',
    dataSchema: [],
  })
  async tagsList(token: string) {
    const tags = await this.wpGet(token, '/wp-json/wp/v2/tags?per_page=100');

    return (Array.isArray(tags) ? tags : []).map((tag: any) => ({
      id: tag.id,
      name: tag.name,
    }));
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<WordpressDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const body = JSON.parse(Buffer.from(accessToken, 'base64').toString()) as {
      domain: string;
      username: string;
      password: string;
    };

    const auth = Buffer.from(`${body.username}:${body.password}`).toString(
      'base64'
    );
    const domain = await this.safeWordpressDomain(body.domain);
    if (!domain) {
      throw new Error('Invalid WordPress domain');
    }

    let mediaId = '';
    if (postDetails?.[0]?.settings?.main_image?.path) {
      console.log(
        'Uploading image to WordPress',
        postDetails[0].settings.main_image.path
      );

      const blob = await this.mediaBlob(
        postDetails[0].settings.main_image.path
      );

      const mediaResponse = await (
        await this.fetch(this.wordpressUrl(domain, '/wp-json/wp/v2/media'), {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Disposition': `attachment; filename="${postDetails[0].settings.main_image.path
              .split('/')
              .pop()}"`,
            'Content-Type': blob.type,
          },
          body: blob,
        })
      ).json();

      mediaId = mediaResponse.id;
    }

    const categories = (postDetails?.[0]?.settings?.categories || [])
      .map((category) => Number(category))
      .filter((category) => !isNaN(category));
    const tags = (postDetails?.[0]?.settings?.tags || [])
      .map((tag) => Number(tag))
      .filter((tag) => !isNaN(tag));

    const submit = await (
      await this.fetch(
        this.wordpressUrl(
          domain,
          `/wp-json/wp/v2/${postDetails?.[0]?.settings?.type}`
        ),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          body: JSON.stringify({
            title: postDetails?.[0]?.settings?.title,
            content: postDetails?.[0]?.message,
            slug: slugify(postDetails?.[0]?.settings?.title, {
              lower: true,
              strict: true,
              trim: true,
            }),
            status: postDetails?.[0]?.settings?.status || 'publish',
            ...(categories.length ? { categories } : {}),
            ...(tags.length ? { tags } : {}),
            ...(mediaId ? { featured_media: mediaId } : {}),
          }),
        }
      )
    ).json();

    return [
      {
        id: postDetails?.[0].id,
        status: 'completed',
        postId: String(submit.id),
        releaseURL: submit.link,
      },
    ];
  }

  capabilities(): IntegrationCapabilities {
    return {
      identifier: 'wordpress',
      textMaxChars: 100000,
      textMaxCharsPremium: null,
      titleMaxChars: null,
      mediaKinds: ['text', 'image'],
      maxImages: null,
      maxImageBytes: null,
      maxVideoSeconds: null,
      maxVideoSecondsDynamic: false,
      aspectRatios: [],
      allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'],
      flags: [],
      textFormat: 'html',
      notes: 'Blog post title — no Postiz-side limit enforced; allowed extensions enforced by MediaDto ValidUrlExtension (libraries/helpers/src/utils/valid.url.path.ts:11-16)',
    };
  }
}
