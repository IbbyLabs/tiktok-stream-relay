# IbbyLabs TikTok Stream Relay

Self-hosted TikTok Stream Relay backend for Eclipse.

## Requirements

- Node.js 20+
- npm
- FFmpeg available on the host for local transcoding fallback
- Optional Torbox token for Debrid-first resolution

## Local Setup

1. Install dependencies:
   `npm install`
2. Create an optional `.env` file:

```env
PORT=3000
CACHE_ROOT=./cache
DEBRID_ENABLED=true
TORBOX_TOKEN=
REDIS_URL=
STREAM_TIMEOUT_MS=30000
STREAM_LOCAL_TTL_MS=172800000
STREAM_CACHE_MAX_BYTES=53687091200
SEARCH_MEMORY_TTL_MS=1800000
SEARCH_DISK_TTL_MS=86400000
LIVE_SEARCH_MAX_RESULTS=36
SEARCH_MAX_LIMIT=60
TIKTOK_AUTH_COOKIE=
SEARCH_RETRY_MAX_ATTEMPTS=2
SEARCH_RETRY_BASE_DELAY_MS=250
TRENDING_REFRESH_ON_STARTUP=false
TRENDING_REFRESH_INTERVAL_MS=21600000
TRENDING_SEED_QUERIES=sabrina carpenter,billie eilish,chappell roan,doechii,benson boone,lady gaga bruno mars
TRENDING_MAX_ITEMS=12
ADDON_CONFIG_ENABLED=true
ADDON_LIFECYCLE_ENABLED=true
ADDON_LINK_TTL_SECONDS=604800
ADDON_LINK_SIGNING_KEYS=
ADDON_CRYPTO_SECRET=
PUBLIC_LAUNCH_MODE=false
ADMIN_TELEMETRY_TOKEN=
PUBLIC_ALLOWLIST_IPS=
```

For local use, blank addon secret values are fine and the service will use `config/runtime-secrets.json`.
If you do set `ADDON_LINK_SIGNING_KEYS` manually, use either `v1:<secret>` or a single raw secret, which is treated as `v1`.

3. Start the dev server:
   `npm run dev`
4. Build for production:
   `npm run build`
5. Run the built service:
   `npm start`
6. Refresh the live trending list:
   `npm run refresh:trending`

The search endpoint is sound-first. For live keyword queries it prefers TikTok sound metadata from the `music` payload, then uses the matching video only as the source stream URL.
The server also refreshes `config/trending-sounds.json` automatically on startup and on a timer.

## Docker

The repo now ships two compose entrypoints:

- `local-compose.yaml`: local source-build path for direct self hosting.
- `compose.yaml`: template stack path for Traefik and prebuilt GHCR images.

Build the image manually:

```bash
docker build -t tiktok-stream-relay .
```

Run the container:

```bash
docker run --rm -p 3000:3000 \
  -e DEBRID_ENABLED=true \
  -e TORBOX_TOKEN=your-token \
   tiktok-stream-relay
```

The image installs FFmpeg in the runtime layer and serves the addon on port 3000.

Run local hosting compose:

```bash
docker compose -f local-compose.yaml up -d --build
```

Run template stack compose (Traefik style):

```bash
docker compose up -d
```

Template compose prerequisites:

- `TIKTOK_STREAM_RELAY_HOSTNAME` set in `.env`
- `DOCKER_NETWORK` and `DOCKER_NETWORK_EXTERNAL` aligned with your root stack settings
- Traefik running in the same compose project

### Template Deployment Guide

If you are using a VPS template stack (Traefik + shared external network), this is the recommended flow.

1. Copy `env.template` to `.env`.
2. Set required stack values:
   - `TIKTOK_STREAM_RELAY_HOSTNAME` (public host, for example `relay.example.com`)
   - `DOCKER_DATA_DIR` (for persistent cache and config mounts)
   - `DOCKER_NETWORK` and `DOCKER_NETWORK_EXTERNAL` (same values used by your root template)
3. Keep image settings for out of box startup:
   - `GHCR_IMAGE=ghcr.io/ibbylabs/tiktok-stream-relay`
   - `IMAGE_TAG=latest`
4. Render config to validate variables:
   - `docker compose config`
5. Start:
   - `docker compose up -d`

Template mode notes:

- `compose.yaml` uses `expose` and Traefik labels, not direct host port mapping.
- If you are not using Authelia yet, leave middleware commented out in `compose.yaml`.
- If you are not using Debrid yet, leave `TORBOX_TOKEN` empty and set `DEBRID_ENABLED=false`.

### Environment Reference (Template + Local)

Deployment identity:

- `COMPOSE_PROJECT_NAME`: container project name prefix.
- `GHCR_IMAGE`: container image repository to pull from in template mode.
- `IMAGE_TAG`: image tag to deploy (`latest` or a version tag).

Template reverse proxy:

- `TIKTOK_STREAM_RELAY_HOSTNAME`: required in stack mode, host used by the Traefik router rule.
- `DOCKER_NETWORK`: compose network name matching your root template.
- `DOCKER_NETWORK_EXTERNAL`: whether that network is external.
- `DOCKER_DATA_DIR`: base path for persistent app data mounts.

Core runtime:

- `PORT`: internal service port.
- `CACHE_ROOT`: cache root path.
- `REDIS_URL`: required for public launch mode.

Debrid and source access:

- `DEBRID_ENABLED`: enable Torbox-first stream resolution.
- `TORBOX_TOKEN`: token used when Debrid is enabled.
- `TIKTOK_AUTH_COOKIE`: optional auth cookie to improve search fetch reliability.

Streaming and cache controls:

- `STREAM_TIMEOUT_MS`: stream resolver timeout.
- `STREAM_LOCAL_TTL_MS`: local stream cache TTL.
- `STREAM_CACHE_MAX_BYTES`: max size of stream cache.
- `SEARCH_MEMORY_TTL_MS`: in-memory search cache TTL.
- `SEARCH_DISK_TTL_MS`: disk search cache TTL.

Search controls:

- `LIVE_SEARCH_MAX_RESULTS`: max results collected from source query.
- `SEARCH_MAX_LIMIT`: API max allowed `limit` value.
- `SEARCH_RETRY_MAX_ATTEMPTS`: retry attempts for transient search failures.
- `SEARCH_RETRY_BASE_DELAY_MS`: base delay for retry backoff.

Trending controls:

- `TRENDING_REFRESH_ON_STARTUP`: refresh trending list on boot. Default is `false` so normal starts use the shipped cached list.
- `TRENDING_REFRESH_INTERVAL_MS`: periodic refresh interval.
- `TRENDING_SEED_QUERIES`: seed queries for trending discovery.
- `TRENDING_MAX_ITEMS`: max curated trending items.

Public portal and security:

- `ADDON_CONFIG_ENABLED`: enable `/configure` portal.
- `ADDON_LIFECYCLE_ENABLED`: enable lifecycle mutation endpoints.
- `ADDON_LINK_TTL_SECONDS`: addon link token TTL.
- `ADDON_LINK_SIGNING_KEYS`: required for secure public mode. Use `v1:<secret>` for explicit versioning. A single raw secret is accepted for local use and is treated as `v1`.
- `ADDON_CRYPTO_SECRET`: required for secure public mode.
- `PUBLIC_LAUNCH_MODE`: enforce strict public safety checks.
- `ADMIN_TELEMETRY_TOKEN`: required for `/public/metrics` and `/public/events`.
- `PUBLIC_ALLOWLIST_IPS`: optional allowlist for sensitive paths.

GHCR pull examples:

```bash
docker pull ghcr.io/ibbylabs/tiktok-stream-relay:latest
docker pull ghcr.io/ibbylabs/tiktok-stream-relay:v0.1.1
```

## Eclipse Addon URL

Use the manifest URL in Eclipse:

```text
http://localhost:3000/manifest.json
```

If you run the addon remotely, replace `localhost` with your host or VPS domain.

If you generate a tokenized link from `/configure`, use the exact URL provided. It now uses a path-safe format:

```text
http://localhost:3000/addon/<token>/manifest.json
```

## Endpoints

- `GET /manifest.json`
- `GET /health`
- `GET /search?q=<query>`
- `GET /search?q=<query>&limit=<n>`
- `GET /search?q=<query>&limit=<n>&cursor=<opaque-cursor>`
- `GET /search?q=<query>&refresh=true`
- `GET /stream/:id?url=<tiktok-url>&format=mp3`
- `GET /cache/stats`
- `GET /configure`
- `POST /api/config/preview`
- `POST /api/config/create`
- `POST /api/config/:linkId/update`
- `POST /api/config/:linkId/rotate`
- `POST /api/config/:linkId/revoke`
- `POST /api/config/:linkId/rollback`
- `GET /public/metrics`
- `GET /public/events`
- `GET /settings`
- `POST /settings`

## Public Config Portal

- Open `GET /configure` to manage addon link generation and lifecycle operations.
- Generated links are tokenized and rotatable.
- Streaming can use addon token credentials through `addonToken` query param or `x-addon-link-token` header.
- Lifecycle mutations require a valid addon token whose link identity matches the route link id.

Example stream with addon token:

```bash
curl -s "http://localhost:3000/stream/<track-id>?addonToken=<token>"
```

## Public Safety and Observability

- Per-IP route class limits apply to portal, lifecycle, and stream surfaces.
- Adaptive throttling increases restrictions for repeated violations.
- Feature flags control portal and lifecycle exposure:
   - `ADDON_CONFIG_ENABLED`
   - `ADDON_LIFECYCLE_ENABLED`
- Metrics and events are available at:
   - `GET /public/metrics`
   - `GET /public/events`
- Both telemetry endpoints require `x-admin-token` to match `ADMIN_TELEMETRY_TOKEN`.
- In public launch mode (`PUBLIC_LAUNCH_MODE=true`), the service requires secure values for:
   - `ADDON_LINK_SIGNING_KEYS`
   - `ADDON_CRYPTO_SECRET`
   - `ADMIN_TELEMETRY_TOKEN`
   - `REDIS_URL`

## Authelia

Use [authelia-rules.template.yaml](authelia-rules.template.yaml) for protected deployments.

Template stack flow (Viren style):

1. Set `TIKTOK_STREAM_RELAY_HOSTNAME` in your stack `.env`.
2. In your Authelia compose environment, set `TEMPLATE_TIKTOK_STREAM_RELAY_HOSTNAME: ${TIKTOK_STREAM_RELAY_HOSTNAME?}`.
3. Copy the rule block from `authelia-rules.template.yaml` into `configuration.yml` before wildcard catch-all rules.
4. In `compose.yaml`, uncomment the optional middleware label for `authelia@docker`.

Standalone flow:

1. Replace `{{ env "TEMPLATE_TIKTOK_STREAM_RELAY_HOSTNAME" }}` with your public host.
2. Copy the same rules into your Authelia `access_control` section before broad one_factor or two_factor rules.
3. Keep media routes (`/manifest.json`, `/addon/*/manifest.json`, `/search`, `/stream`) on bypass and protect the rest with your default policy.

Authelia is optional. Both compose paths still run without it.

## Releases and Packages

Release flow:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Each release script now:

- runs `lint`, `test`, and `build`
- bumps `package.json` and `package-lock.json`
- syncs the add-on version in [manifest.json](manifest.json)
- refreshes versioned GHCR pull examples in [README.md](README.md)
- generates the matching [CHANGELOG.md](CHANGELOG.md) entry from commits since the previous tag
- commits the release, creates the semantic tag, and pushes `main` with tags

Pushing a semantic tag like `v0.1.1` triggers [release.yml](.github/workflows/release.yml):

- create GitHub release notes from the matching [CHANGELOG.md](CHANGELOG.md) entry
- publish a GitHub release for that tag
- build and push multi-arch GHCR images (`linux/amd64`, `linux/arm64`)
- publish both `${tag}` and `latest` image tags

The workflow keeps release notes, add-on versioning, changelog entries, and image tags aligned to the same release tag.

## Settings API

Example request:

```bash
curl -X POST http://localhost:3000/settings \
  -H "content-type: application/json" \
  -d '{"debridEnabled":true,"torboxToken":"token-value-1234"}'
```

## Troubleshooting

### FFmpeg not found

Install FFmpeg on the host and confirm `ffmpeg` is on `PATH`.

### Search returns empty results

- Try `GET /search?q=trending`
- Try a live sound query like `GET /search?q=espresso`
- Try a broader sound query like `GET /search?q=random music`
- Check whether the source TikTok page changed its embedded payload structure
- Refresh the local trending list with `npm run refresh:trending`
- Use cached results while updating the parser extraction patterns

### Search pagination

First page:

```bash
curl -s "http://localhost:3000/search?q=tate%20mcrae%20leaks&limit=20" | jq
```

Follow-up page (use the returned `nextCursor`):

```bash
cursor="<nextCursor-from-previous-response>"
curl -s "http://localhost:3000/search?q=tate%20mcrae%20leaks&limit=20&cursor=${cursor}" | jq
```

Response fields:

- `tracks`: normalized search results for the page
- `hasMore`: whether another page may be available
- `nextCursor`: opaque cursor for the next page when `hasMore=true`
- `partial`: true when throttling occurred after collecting partial results

### Stream resolution fails

- Verify the TikTok URL is absolute and uses a supported TikTok host
- If Debrid is enabled, confirm the token is still valid
- Retry with local fallback by disabling Debrid through `POST /settings`

### Cache debugging

- Inspect `GET /cache/stats`
- Clear a specific search cache entry with `GET /search?q=<query>&refresh=true`
- Update Debrid tokens through `POST /settings` to clear search cache after token changes

## Validation Commands

- `npm run typecheck`
- `npm test`
- `npm run lint`
- `npm run format:check`
- `npm run refresh:trending`

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
