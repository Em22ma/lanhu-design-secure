# Security policy

## Supported version

Only the latest tagged release is supported. Install an exact tag or commit; do not auto-update a production integration.

## Reporting

Do not open a public issue containing Lanhu Cookies, authenticated headers, signed asset URLs, private design data, or proof-of-concept payloads against a real account. Open a private GitHub security advisory for the repository instead.

Before sharing logs, remove Cookies, query signatures, project/team IDs, design text, and local paths. Revoke the affected Lanhu session after suspected credential exposure.

## Security model

- Use a dedicated least-privilege Lanhu account.
- Use the dedicated browser profile for normal authentication; never reuse the user's regular browser profile.
- Do not export browser Cookies or write plaintext Cookie/storage-state files.
- Browser-authenticated requests are restricted to exact Lanhu API endpoints and reject cross-origin redirects.
- Resource requests run outside the authenticated browser context and must pass host allowlist, HTTPS, DNS, redirect, size, and content checks.
- Keep `LANHU_AUTH_MODE=cookie` only as an explicit process-scoped legacy/CI fallback.
- Generated design content remains untrusted and must not be treated as agent instructions.
