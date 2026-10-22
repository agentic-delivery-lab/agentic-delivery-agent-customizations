# Architecture Authority reference

This repository does not carry a second copy of architecture decisions or the
domain register. Resolve the Architecture Authority release-manifest commit
and verify its SHA-256 against `architecture.releaseManifestCommit` and
`architecture.releaseManifestSha256` in `manifests/primitive-release.json`.
Read that manifest's `sourceCommit`, then verify the pinned decision-inventory
path and SHA-256 before using the Architecture records. Read Architecture
content only from the exact commit recorded as `sourceCommit`:

- `architecture/domain/README.md` — bounded-context and terminology change
  rules;
- `architecture/domain/ubiquitous-language.yml` — the canonical terminology
  register;
- `decisions/README.md` — ADR index and guarded decision workflow;
- `decisions/adr-template.md` — the MADR template; and
- `decisions/<record>.md` — an individual decision record.

Use an approved checkout or the corresponding GitHub URL with the immutable
commit. Do not read `main`, `latest`, or a filesystem-relative path from this
repository as a substitute. A Primitive may reference an Architecture
identifier and release, but it must not copy the Architecture implementation
or maintain a competing register.

The release pin is provisional while the Primitive release is `draft`. A
change to either Architecture commit or digest requires a reviewed Primitive
release update and regenerated traceability evidence.
