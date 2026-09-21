# Contributing

Thank you for helping improve CF Account Operator.

## Before opening a pull request

1. Keep adapters deterministic and domain allowlisted.
2. Never add CAPTCHA bypass, stealth plugins, fingerprint spoofing, or bot-protection evasion.
3. Keep irreversible actions behind an explicit prepare/commit approval boundary.
4. Add or update tests.
5. Run `npm test` and `npm run check`.

## Reporting security issues

Do not open a public issue for vulnerabilities involving authentication, profile encryption, Live View URLs, cross-account access, SSRF, or credential exposure. Follow `SECURITY.md` instead.
