## What and why

## Checklist
- [ ] `npm run check` passes (lint and unused-code scan)
- [ ] `npm test` passes (conversions that need an engine you lack are skipped, not failed)
- [ ] New or changed conversions have a fixture and a content check in `test/integration/conversion/matrix.test.js`
- [ ] Nothing leaves the machine while converting (no telemetry, no remote fetches)
- [ ] New dependencies are open source, compatible with AGPL-3.0-or-later, and added to `THIRD_PARTY_NOTICES.md`
- [ ] I have read the [Contributor Licence Agreement](https://github.com/zzvimalzz/pomelo/blob/staging/CLA.md) and agree to it for this contribution and my later ones
- [ ] Anything in it that is not my own work is named, with its source and licence, above
