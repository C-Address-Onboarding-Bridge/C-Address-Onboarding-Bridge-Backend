# CloudFront API Cache

CloudFront applies the `api_dynamic` cache policy to these API routes:

| Route pattern | Cached methods | Default TTL | Maximum TTL |
|---------------|----------------|-------------|-------------|
| `/api/*/quote` | `GET`, `HEAD` | 30 seconds | 60 seconds |
| `/api/*/status/*` | `GET`, `HEAD` | 30 seconds | 60 seconds |

The cache key includes the `Accept` and `X-Api-Key` request headers and all
query-string parameters. Including `X-Api-Key` keeps responses scoped to the
credential sent with each request; requests with different keys, or without a
key, use separate cache entries. `Authorization` is forwarded to the API origin
but is not part of the cache key because the API authenticates with `X-Api-Key`.

The origin may set a shorter TTL; CloudFront's configured maximum is 60 seconds
and its minimum is 0. Other API routes use their own cache behavior and are not
covered by this dynamic cache policy.