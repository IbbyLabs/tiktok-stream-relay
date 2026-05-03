# Changelog

<a id="v0-1-0"></a>

<a id="v0-1-1"></a>

<a id="v0-2-0"></a>

<a id="v0-4-0"></a>

## [v0.4.0] - 03/05/2026

### Added
* improve search results, catalog browsing, and addon icon
  
  - Search results no longer expose internal stream URLs
  - Album and artist pages now load correctly when opened immediately
    after a search, without needing a second network round trip
  - Stream URLs now include an expiry timestamp when the source provides one
* add hybrid catalog support
  
  - derive albums artists and playlists from TikTok search tracks
  - add catalog detail endpoints for album artist and playlist
  - expand search response with catalog arrays and streamURL
  - update manifest resources and types for catalog capability
  - add end to end tests for hybrid catalog responses and detail routes
  - align README endpoint docs with the new catalog routes

### Fixed
* trust proxy to return https media URLs behind reverse proxy
  
  The app was behind Cloudflare and nginx but had no trust proxy setting,
  so request.protocol resolved to http instead of https. Stream responses
  returned http:// media URLs which hit a 301 redirect that Eclipse could
  not follow, causing playback to silently stop.
  
  Setting trust proxy to 1 causes Express to read X-Forwarded-Proto from
  the upstream proxy, so media URLs are built with the correct scheme.
* use root option with sendFile for express 5 compatibility
  
  express 5 / send 1.x no longer accepts absolute paths passed directly
  to res.sendFile. Both the manifest route and the media file route were
  affected, causing every file serve to return 404.
  
  Fixed by passing path.basename as the file argument and path.dirname
  as the root option, which is the correct pattern for express 5.
* fall back to music CDN URLs when playAddr is redacted
  
  TikTok now returns empty strings for playAddr and downloadAddr in
  server-side page HTML. Streams that relied on those fields were
  failing for every track.
  
  The music.playUrl CDN URLs (sf16-ies-music-sg.tiktokcdn.com) are
  still populated and return accessible audio/mp4 content. Added a
  fallback extraction pass in extractPlayableUrlsFromPageHtml that
  captures these CDN URLs and appends them after the existing
  playAddr/downloadAddr/mpeg candidates, so the resolution order
  is preserved and streams play again.
* push release tags explicitly
  
  Ensure npm run release pushes the exact version tag ref alongside the
  release commit so GitHub Actions receives the tag push event and runs the
  release workflow automatically.
  
  Also update manual release workflow dispatches to check out the requested
  release tag before building and publishing the Docker image, keeping manual
  reruns aligned with the selected release instead of the default branch.

### Other Changes
* Merge pull request #1 from IbbyLabs/renovate/configure
  
  chore: Configure Renovate
* Add renovate.json

## [v0.2.0] - 25/04/2026

### Added
* redesign /configure page

### Other Changes
* build docker image before publishing release

## [v0.1.1] - 14/04/2026

### Fixed
* align clip duration and local startup
* support GHCR token override
* allow manual tag release rerun

### Other Changes
* align slug to tiktok-stream-relay

## [v0.1.0] - 14/04/2026

### Added
- initial IbbyLabs TikTok Stream Relay release
- sound-first search and stream endpoints
- secure public config portal and lifecycle controls
