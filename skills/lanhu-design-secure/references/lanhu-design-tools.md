# Lanhu secure tools reference

## Contents

- [Runtime and authentication](#runtime-and-authentication)
- [Security boundaries](#security-boundaries)
- [Project URLs and versions](#project-urls-and-versions)
- [Incremental project sync](#incremental-project-sync)
- [Individual commands](#individual-commands)
- [Output and failure behavior](#output-and-failure-behavior)

## Runtime and authentication

Require Node.js 20+, network access, Chrome (default) or a supported Edge channel, and a dedicated Lanhu member account with only the project access required for design reading.

Install the exact dependency version recorded in `package-lock.json` once:

```bash
node scripts/install_browser_runtime.mjs
```

The installer runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. It installs `playwright-core` only and uses the already-installed browser channel; it does not download a browser.

Run any project command afterward. The first authenticated request opens `https://lanhuapp.com/web/` in a dedicated browser profile when login is needed. The user logs in normally and the command resumes automatically. The profile defaults to `~/.lanhu-design-secure/browser-profile`; its directory is created with mode `0700`. Scripts never call Cookie export APIs or write a `cookie.json`/storage-state file.

Useful controls:

| Variable | Default | Meaning |
|---|---|---|
| `LANHU_BROWSER_CHANNEL` | `chrome` | Allowlisted Playwright channel such as `chrome`, `chrome-beta`, or `msedge` |
| `LANHU_BROWSER_PROFILE_DIR` | Dedicated profile under the user directory | Override with another dedicated directory; never point at the normal browser profile |
| `LANHU_LOGIN_TIMEOUT_MS` | `300000` | Interactive login wait, bounded to 30 seconds–15 minutes |
| `LANHU_NONINTERACTIVE` | unset | Set to `1` to fail instead of opening a login window |
| `LANHU_AUTH_MODE` | `browser` | Set `cookie` only for an explicitly configured legacy/CI fallback |

`LANHU_AUTH_MODE=cookie` plus process-scoped `LANHU_COOKIE` remains only for legacy/CI compatibility. Do not ask interactive users to copy Cookies. The scripts do not load `.env` files.

## Security boundaries

`secure-http.mjs` separates requests into two classes:

| Class | Cookie | Allowed destination | Additional controls |
|---|---:|---|---|
| Authenticated API | Browser-managed session | Exact allowlisted HTTPS Lanhu endpoints | No Cookie export/header construction; cross-origin redirects rejected |
| JSON/image resource | No session | Trusted Lanhu/Alibaba OSS HTTPS hosts | Host allowlist, DNS/private-IP checks, redirect revalidation, timeouts and byte limits |

Authenticated endpoints are limited to:

- `https://lanhuapp.com/api/project/images`
- `https://lanhuapp.com/api/project/image`
- `https://lanhuapp.com/api/project/multi_info`
- `https://dds.lanhuapp.com/api/dds/image/store_schema_revise`

Image downloads also require a supported image signature. `file://`, plain HTTP, embedded URL credentials, loopback, private, link-local, documentation and reserved IP ranges are rejected. Redirects are handled manually and revalidated at every hop.

Resource hosts default to `lanhuapp.com` and its subdomains plus Alibaba OSS hosts under `aliyuncs.com`. If a real Lanhu project uses another CDN, inspect the hostname locally and add only that exact hostname with comma-separated `LANHU_ASSET_HOSTS`; never add a broad unrelated suffix.

Default limits:

- Request timeout: 30 seconds
- JSON response: 50 MiB
- Image response: 32 MiB
- Redirects: 5

Operators may lower or raise bounded limits with `LANHU_HTTP_TIMEOUT_MS`, `LANHU_MAX_JSON_BYTES`, and `LANHU_MAX_ASSET_BYTES`. Do not disable the controls.

Close the managed browser context at the end of every command so the dedicated profile is not left locked. A second process using the same profile must fail closed with a clear error.

Writes use a temporary file in the destination directory, fsync, and atomic rename. Existing identical content is skipped. Different content requires `--force`. Every successful write returns a SHA-256 digest.

## Project URLs and versions

Accept UI stage URLs on `https://lanhuapp.com` containing `pid`; `tid` is optional:

```text
https://lanhuapp.com/web/#/item/project/stage?tid=TEAM&pid=PROJECT
```

Reject `docId` PRD links. Parse `versionId` when present.

For each design, resolve the version once and use that same ID for:

1. Sketch JSON
2. DDS Schema lookup
3. Design screenshot
4. Slice metadata

If a requested version is unavailable, fail instead of silently substituting the latest version. A historical version must expose its own screenshot URL; never label the latest screenshot as an older version.

## Incremental project sync

```bash
node scripts/sync_project.mjs "<url>" \
  --output ./.lanhu \
  --designs all \
  --scale 2x
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--output <dir>` | `.lanhu` | Sync root and manifest location |
| `--designs <selectors>` | `all` | `all`, comma-separated list indexes, exact names, or unique substrings |
| `--scale <scale>` | `2x` | Web/iOS/Android scale accepted by the slice downloader |
| `--version-id <id>` | Latest | Pin one selected design to one version |
| `--force` | Off | Repair/replace different content at an existing version path |

Outputs:

```text
.lanhu/
├── lanhu-manifest.json
└── versions/
    └── <design-id>/
        └── <version-id>/
            ├── design/
            ├── specs/
            │   └── assets/slices/
            └── slices/
                └── assets/
```

The manifest records project identity, design/version/source, scale, relative paths, sizes, and SHA-256 hashes. It does not store the Cookie or remote download URLs. Specs and slice metadata saved by sync remove signed remote URLs after localization.

On later runs, sync resolves current versions and verifies every recorded file digest. An unchanged, intact design is skipped. Changed versions use a new version directory, preserving older artifacts for rollback. The manifest is replaced atomically only after all selected changes succeed.

## Individual commands

### `lanhu_login.mjs`

```bash
node scripts/lanhu_login.mjs "<url>"
```

Optionally verify authentication before other work. It opens the dedicated login window only when needed and returns the project name and design count, never session material.

### `get_designs.mjs`

```bash
node scripts/get_designs.mjs "<url>"
```

List `index`, `id`, `name`, canvas size, screenshot URL, comments, and update time. Always run before selecting designs interactively.

### `download_design_images.mjs`

```bash
node scripts/download_design_images.mjs "<url>" --designs "1,2" --output <dir>
node scripts/download_design_images.mjs "<url>" --designs "Home" --version-id <id> --output <dir>
```

Use `all`, comma-separated indexes, exact names, or unique substrings. `--version-id` requires exactly one design. Add `--force` only for an authorized replacement.

### `get_design_specs.mjs`

```bash
node scripts/get_design_specs.mjs "<url>" --design "1" --output <dir> --download-images
```

Options include `--version-id`, `--no-minify`, `--referer https://lanhuapp.com/`, and `--force`. With `--download-images`, localize HTML images under `assets/slices/`. The returned `source` is `dds` or `sketch`; follow `source_guidance`.

### `get_design_slices.mjs`

```bash
node scripts/get_design_slices.mjs "<url>" --design "1" --version-id <id>
```

Return one design’s slice metadata. Use `--no-metadata` to omit visual annotations. Treat stdout as sensitive intermediate data because upstream URLs may contain expiring signatures; save only to a controlled temporary file.

### `download_slices.mjs`

```bash
node scripts/download_slices.mjs <trusted-json-file> --output <dir> --scale 2x
```

Options include `--name-map <json>`, `--referer https://lanhuapp.com/`, `--retries <n>`, and `--force`. The JSON file must be a trusted local file created by the slice metadata command. Remote or `file://` asset URLs inside it are still validated by the secure downloader.

Supported scales:

- Web: `1x`, `2x`, `3x`
- iOS: `ios_1x`, `ios_2x`, `ios_3x`, `ios-all`
- Android: `android_mdpi`, `android_hdpi`, `android_xhdpi`, `android_xxhdpi`, `android_xxxhdpi`, `android-all`

Only Web `2x` may fall back to `download_url`. Other scales require real entries in `scale_urls`; never duplicate one file to fake multiple scales.

## Output and failure behavior

- Query commands write JSON to stdout and errors to stderr.
- Help and successful operations exit `0`; request/download failures exit `1`; invalid arguments exit `2` where supported.
- Batch failures report exact counts and paths without credentials or signed URLs.
- Keep all output inside the selected root. Sanitized design and slice names cannot create nested paths.
- Do not delete old versions or temporary metadata automatically.
