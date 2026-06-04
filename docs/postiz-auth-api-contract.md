# Postiz public API — auth error and integration health contract

Consumers: **juston-app** posting loop, delivery sync, proactive health gate.

## Structured auth errors (B1)

HTTP error bodies from `/public/v1/*` include machine-readable fields when the failure is auth-related:

| Field            | Type    | Description                                                         |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `error_code`     | string  | Stable code, e.g. `REVOKED_ACCESS_TOKEN`, `INVALID_ORG_API_KEY`     |
| `error_class`    | enum    | `platform_oauth`, `org_api_key`, `integration_missing`, `transient` |
| `integration_id` | string? | Integration UUID when known                                         |
| `message`        | string  | Human-readable summary                                              |
| `http_status`    | number  | HTTP status code                                                    |
| `msg`            | string  | **Legacy** — same as `message` for backward compatibility           |
| `detail`         | string? | Raw upstream text when available                                    |

### Surfaces

- `POST /public/v1/posts` (schedule / create)
- `POST /public/v1/upload`
- `GET /public/v1/posts/status` — `error` on failed posts is a string **or** the structured object above
- `401` from public API auth middleware → `error_class: org_api_key` (missing/invalid org API key or `pos_` access token)

### `error_class` routing (Juston)

| `error_class`         | Operator action               |
| --------------------- | ----------------------------- |
| `platform_oauth`      | Channel reconnect             |
| `org_api_key`         | Org settings → Postiz API key |
| `integration_missing` | Channel sync / reconnect      |
| `transient`           | Retry; do not auth-pause      |

## Integration health (B2)

`GET /public/v1/integrations/health` — each integration includes
credential-free metadata plus:

```json
{
  "auth": {
    "status": "connected",
    "needs_reconnect": false,
    "token_expires_at": "2026-06-01T12:00:00Z",
    "last_success_at": "2026-05-29T10:00:00Z",
    "last_error_code": null,
    "reconnect_reason": null
  }
}
```

### `auth.status`

| Value             | Meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `connected`       | Token present; not flagged for refresh                 |
| `expiring_soon`   | `token_expires_at` within 7 days                       |
| `needs_reconnect` | `refreshNeeded`, missing token, or non-OAuth reconnect |
| `unknown`         | Mid OAuth connect (`inBetweenSteps`) — do not pause    |

### `reconnect_reason`

| Value                | When                              |
| -------------------- | --------------------------------- |
| `refresh_failed`     | `refreshNeeded` on OAuth provider |
| `token_expired`      | Empty token                       |
| `non_oauth_provider` | Telegram and similar              |

Health is derived from integration DB fields (`refreshNeeded`, `tokenExpiration`, …), not live platform probes, to avoid false pauses on Postiz outages.

## Juston feature flag

Set `POSTIZ_PROACTIVE_AUTH_HEALTH=1` on juston-app after Postiz with this
contract is deployed.
