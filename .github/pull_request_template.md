## Summary

## Safety impact

- [ ] Navigation remains domain allowlisted.
- [ ] No credential or Live View data is logged.
- [ ] Irreversible actions require an explicit approval boundary.
- [ ] This change does not bypass bot protection or CAPTCHA.

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npx wrangler deploy --dry-run`
