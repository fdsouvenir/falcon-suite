# Falcon Vault UUID reference release — October 22, 2026

## Published; security qualification remains open

Source: [57752e0](https://github.com/fdsouvenir/falcon-suite/commit/57752e0f6e5c3808f9d8415d469bd54f2e63e77b).
Both ClawHub listings have the new release as `latest`. No alpha or live Gateway installation was performed.

| Channel | Package | Version | Scan |
| --- | --- | --- | --- |
| Preview | @fdsouvenir/falcon-vault-preview | 5.0.0-preview.7 | suspicious |
| Stable | @fdsouvenir/falcon-vault | 1.1.0 | suspicious |

## Delivered

- Stable `entry/<uuid>` config IDs derived from existing KeePass UUIDs (unpadded base64url); no database migration or renamed entries.
- Copy config reference supplies the full SecretRef with the current provider alias.
- Legacy path and field-selector references remain supported. Used by recognizes both formats.
- UUID references survive entry and folder renames/moves. Only legacy path usages warn on rename.
- Recycled or deleted entries fail closed. Restoring an entry restores its UUID reference; recreating its title does not. UUID/path collisions reject ambiguity.
- Resolver reads are audited against the current entry path and UUID, without credential values.

## Verification

- `npm ci --include=dev`; `npm run build`; `npm run validate`; `npm test`; `npm run format:check`: passed.
- 89 repository tests passed (37 Vault, 52 Work); 23 resolver/storage tests passed against the staged preview package.
- Full copied config-reference JSON checked through the UI formatter; no live browser/Gateway acceptance claimed.
- [Source CI](https://github.com/fdsouvenir/falcon-suite/actions/runs/39852548606): completed/success for the exact source commit.
- Both downloaded archives: registry SHA-256, npm SHA-512 integrity and npm SHA-1 match; every one of 32 files matches its validated staged build byte-for-byte.
- Package, manifest, runtime identity and UI version checked for both staged channels. Downloaded archives match those files exactly.
- Registry provenance is source-linked, artifact-only, without build attestations. Community/non-official status is not treated as a failed scan.
- No Git tag or GitHub Release: this repository uses channel-specific package staging and publication instead.
- Tracked worktree clean and pushed. Pre-existing untracked `AGENTS.md` and `.openclaw-cli-images/` left untouched.

### Changed lines (separate categories)

- production: 82 added, 63 removed.
- tests: 117 added, 6 removed.
- docs_manifest: 34 added, 18 removed.

Dependency install also reported 5 audit vulnerabilities (2 moderate, 3 high) in the existing dependency tree. No dependencies or audit overrides were changed in this feature release.

## Open scan gate

Both ClawHub final reviews are `suspicious`; static scans are clean. These are actual unresolved scan results, not clean qualification. The available new-version reports provide summaries but no detailed supporting findings. No security controls were weakened, reports overridden, or packages resubmitted. No unrelated retrieval, deletion or storage behavior was changed for this feature.

### Preview 5.0.0-preview.7

Scanner summary: This vault clearly discloses credential access, but verified storage, deletion, and history gaps warrant review before trusting it with important passwords.

SHA-256: `9178f4e6ba6ae69f2b80f64299dcf428a6129229ea838fe95b5388b2094057ab`

### Stable 1.1.0

Scanner summary: Review is warranted because deletion can be permanent despite recovery promises, and protections against lost changes and incomplete history have gaps.

SHA-256: `af72db3da587d4ddb37e51899728da3a6f2e760dbd2ddd70684d549e20d0ec75`

Remaining work: investigate the scanner concerns against concrete storage/deletion/history behavior; release publication is verified, clean security qualification is not.
