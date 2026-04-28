/**
 * Per-provider posting capabilities. Returned verbatim by
 * GET /public/v1/admin/capabilities so first-party callers (juston-app)
 * can render compose-time validation hints without hard-coding limits.
 *
 * Values reflect what *Postiz* enforces today, not the upstream platform's
 * theoretical ceiling. e.g. X's 200/4000 ceiling is Postiz-enforced; the
 * real X limit is 280/25000 but Postiz refuses to send longer text.
 *
 * Use null for "no limit / not applicable", [] for "unrestricted".
 * `notes` is one short sentence for quirks the matrix can't express.
 */
export type IntegrationMediaKind =
  | 'text'
  | 'image'
  | 'video'
  | 'gif'
  | 'carousel'
  | 'story'
  | 'reel'
  | 'document_pdf'
  | 'photo_carousel';

export type IntegrationTextFormat = 'plain' | 'markdown' | 'html';

export interface IntegrationCapabilities {
  identifier: string;
  textMaxChars: number | null;
  textMaxCharsPremium: number | null;
  /**
   * Max length of a separate title/subject field (YouTube video title,
   * Pinterest pin title, Reddit submission title, blog post title,
   * Listmonk email subject, ...). `null` when the body and title are the
   * same field — i.e. the provider has no independent title slot.
   *
   * Reflects what *Postiz* enforces today (DTO @MaxLength). When Postiz
   * doesn't enforce a length but the platform does, this stays `null`
   * and the caller must rely on `notes` for guidance — we don't invent
   * values.
   */
  titleMaxChars: number | null;
  mediaKinds: IntegrationMediaKind[];
  maxImages: number | null;
  maxImageBytes: number | null;
  maxVideoSeconds: number | null;
  maxVideoSecondsDynamic: boolean;
  aspectRatios: string[];
  allowedExtensions: string[];
  flags: string[];
  textFormat: IntegrationTextFormat;
  notes: string;
}
