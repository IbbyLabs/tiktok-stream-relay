# Changelog

<a id="v0-1-0"></a>

<a id="v0-1-1"></a>

<a id="v0-2-0"></a>

<a id="v0-4-0"></a>

<a id="v0-5-0"></a>

<a id="v0-5-1"></a>

## [v0.5.1] - 19/05/2026

### Fixed
* harden debrid routing and search fallback diagnostics
  
  - Improves playback reliability for debrid users by validating upstream routing responses and preferring direct playable media links before local fallback.
  
  - Prevents stale routed links from being reused after expiry so playback can recover faster on repeat requests.
  
  - Adds clearer reliability signals in logs when stream routing or search providers fail, making outages and auth problems easier to diagnose.

### Other Changes
* update package lock
* include all release-generated files in release commit
  
  - Refresh trending snapshot data during release so generated content is not left behind
  - Stage every file touched by the release workflow to avoid staggered unstaged changes
  - Keep release documentation aligned with the new behavior and commit scope

## [v0.5.0] - 03/05/2026

### Added
* add description field to album and playlist detail responses
  
  - Album detail (/album/:id) now includes a description field: "TikTok sounds by {artist}"
  - Playlist detail (/playlist/:id) now includes a description field describing the
    query or confirming it is the trending playlist
  - Both fields satisfy the optional description field in the Eclipse addon protocol
  - New test assertions confirm both fields are present as strings in the catalog
    endpoint test
* multi-format output and quality signaling
  
  - Add AudioFormat union: mp3, aac, flac, m4a, wav, ogg
  - Remove forced mp3 in stream route — format now passed through from
    request query param to resolver and ffmpeg
  - Add parseAudioFormat with strict validation; unsupported formats return
    400 unsupported_audio_format (moved inside try block so HttpError is
    caught and returned correctly)
  - Extend ffmpeg resolver arg mapping for m4a (aac+faststart), wav
    (pcm_s16le), and ogg (libvorbis)
  - Add quality field to all stream responses:
    source (direct provider URL), transcoded_lossless_container (flac/wav),
    transcoded_standard (mp3/aac/m4a/ogg)
  - Preserve expiresAt passthrough on routed debrid URL responses
  - Extend contentTypeForFile to return correct MIME type per extension:
    audio/mp4 for m4a, audio/wav for wav, audio/ogg for ogg
  - Expand e2e test to exercise all six formats, assert format/quality
    fields and correct content-type on media route, and verify 400 on
    unsupported format
  - All 43 tests pass, lint clean, build clean

### Documentation
* Update docs
* document multi-format audio support and quality semantics
  
  - Add Audio Format and Quality section to README covering all six supported
    formats (mp3, aac, flac, m4a, wav, ogg), the optional ?format= query param,
    and the 400 error returned for unsupported values
  - Add quality semantics table explaining source, transcoded_standard, and
    transcoded_lossless_container so operators know what each value means
  - Add caveat that TikTok source audio is lossy; a lossless container format does
    not imply lossless source audio
  - Add operator cost warning: wav and flac output is 30-50x larger than mp3 per
    track; size STREAM_CACHE_MAX_BYTES accordingly
  - Update stream endpoint line in the Endpoints section to show the full format
    parameter syntax
  - Add comment on SearchApiMusic interface in ibbylabs-parser-provider noting
    that TikTok's search API does not expose ISRC or UPC fields, so the isrc field
    on NormalizedTrack is intentionally absent for all tracks from this provider

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
