# Changelog

## [Unreleased]

### Changed

- Proposed Primitive draft `0.1.0-draft.9` pins reviewed source `035547fc1c7885e96cf9a8f8295c94a26f269847`, including source-bound review evidence, commit-object validation and complete metadata discovery. CI rejects a proposed release that omits current authoritative content. Earlier draft artifacts remain unchanged; no release or runtime consumer is activated.

- [Issue #2](https://github.com/agentic-delivery-lab/agentic-delivery-primitives/issues/2) binds impact-review evidence to cataloged Primitive source bytes, requires release provenance to identify a commit object, and discovers metadata in every regular text file under the Primitive roots.

- The draft4 release retains the preceding Architecture draft3 pin so the
  Architecture-to-Primitive release graph remains acyclic; Architecture draft4
  consumes this Primitive release in its generated traceability index.

- The draft Primitive release advances to `0.1.0-draft.4` and explicitly
  consumes Architecture draft `0.1.0-draft.3` at
  `d4714c9489fb14824ef0967903d34a73c3e437fb`.

- The draft Primitive release advances to `0.1.0-draft.3` and consumes
  Architecture draft `0.1.0-draft.2` at
  `9b06a4e2202e851cdc700921828aac49d4a90d9d`.

- The draft Primitive release advances to `0.1.0-draft.2` at source commit
  `a39267da377328dbfb1ed210a23b2628c224bed6`, pins the current Architecture
  Authority commit, and records the canonical source digest.

- Added a deterministic content digest for the canonical Primitive source
  tree; release provenance can now bind the source snapshot without hashing
  its own self-referential release field.

- The draft Primitive release now records the immutable source commit containing the extracted skill-boundary correction.

### Added

- Added the history-preserving extraction of reusable skills, the Codex
  delivery agent, and repository-delivery validators.
- Added primitive metadata, release, capability, and tool-policy contracts.
