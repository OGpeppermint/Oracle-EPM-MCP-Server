# Included license material

The authoritative third-party license texts for this release are consolidated in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). That file is generated
from the exact production dependency versions in `package-lock.json` and includes
each package's installed LICENSE and NOTICE files without consolidating distinct
copyright statements.

This directory also contains representative full texts for every license family
present in the server's complete locked installation: MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, and ISC. Apache-2.0 currently occurs only in
development tooling. Package-specific copyright and NOTICE content remains in
`THIRD_PARTY_NOTICES.md`. The separate Command Center repository maintains its
own dependency notices and license material.

Run `npm run notices` after changing dependencies. Run `npm run release:check`
before packaging a commercial release. Development-only packages are excluded
from the distributable notice inventory because production packaging must use
`npm ci --omit=dev` and must not include build-tool dependencies or build layers.

If a release intentionally distributes development dependencies, generate a
separate complete notice inventory for that distribution rather than using this
production-only file.
