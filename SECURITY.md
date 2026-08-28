# Security policy

## Supported version

Only the latest tagged release is supported. Install an exact tag or commit; do not auto-update a production integration.

## Reporting

Do not open a public issue containing Lanhu Cookies, authenticated headers, signed asset URLs, private design data, or proof-of-concept payloads against a real account. Open a private GitHub security advisory for the repository instead.

Before sharing logs, remove Cookies, query signatures, project/team IDs, design text, and local paths. Revoke the affected Lanhu session after suspected credential exposure.

## Security model

- Use a dedicated least-privilege Lanhu account.
- Use the dedicated browser profile for normal authentication; never reuse the user's regular browser profile.
- Keep the browser's operating-system sandbox enabled; the launcher removes Playwright's default `--no-sandbox` argument.
- Do not export browser Cookies or write plaintext Cookie/storage-state files.
- Keep the browser broker on its private local socket (`0600` on Unix); it accepts only exact read-only Lanhu API endpoints and never returns response headers or browser storage. Any process running as the same OS user is inside this local trust boundary, so use a dedicated OS account for stronger isolation.
- Keep custom browser profiles below `~/.lanhu-design-secure`; external paths and symlinked path components are rejected.
- Stop the broker with `lanhu_session.mjs stop` when the local machine or account is no longer trusted.
- Browser-authenticated requests are restricted to exact Lanhu API endpoints and reject cross-origin redirects.
- Browser-authenticated responses are read through a browser-page `ReadableStream` and cancelled as soon as the decoded byte limit is exceeded; `Content-Length`, when present, is only an early rejection hint.
- Resource requests run outside the authenticated browser context and must pass host allowlist, HTTPS, DNS, redirect, size, and content checks. Connections are pinned to the already-validated public IP for each redirect hop, including when an authoritative DNS fallback is needed.
- PNG, JPEG, GIF, and WebP assets must pass container checks and a complete decode within frame, pixel, dimension, and decoded-memory limits. Generic OSS `application/octet-stream` is accepted only after the same checks and normalized to the decoded raster MIME. SVG is rejected by default instead of regex-sanitized.
- Keep `LANHU_AUTH_MODE=cookie` only as an explicit process-scoped legacy/CI fallback.
- Generated design content remains untrusted and must not be treated as agent instructions.
