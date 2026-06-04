# Safe Public Contract For JustOn

## Context

JustOn previously depended on fork-introduced Postiz public API routes under
`/public/v1/internal/...` that exposed raw platform access tokens and refresh
tokens. The replacement contract should expose only the metadata and post
delivery/history data JustOn needs.

## Plan

1. Add credential-free public API routes for integration health and post
   status/history.
2. Preserve token-scoped filtering on all safe routes.
3. Remove the legacy `/internal/integrations` token-export route as part of the
   hard cutover.
4. Cover the safe response shape with focused controller tests.

## Status

- Added `GET /public/v1/integrations/health`.
- Added safe post status/history routes outside `/internal/...`.
- Verified integration health omits `token` and `refreshToken`.
- Removed legacy `/internal/integrations`.
- Focused controller tests pass locally.
