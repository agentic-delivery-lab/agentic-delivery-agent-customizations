# Changelog

## [Unreleased]

### Fixed

- Pin deterministic evaluation metadata to the grader definition and record the replay runner separately. Local replay honors the documented Architecture root while retaining exact schema-digest checks. Verify prepared-source ancestry and preserve it through merge-commit integration.

- Evaluation catalog `0.6.0` pins the accepted validator metadata and combined digest runner `1.1.0`. Replay rejects stale dependency hashes rather than silently executing changed artifacts. The four-case dataset and pinned baseline remain unchanged.

- Offline replay now describes the actual candidate and baseline pass rates in its improvement-hypothesis rationale. A better or worse synthetic result cannot be described as equal, and no production hypothesis is inferred. Comparison regressions cover both metric directions; the updated runner is prepared as draft `0.1.0-draft.10`, with no release publication or runtime adoption.


### Changed

- Draft `0.1.0-draft.12` combines the accepted catalog/impact validation with offline evaluation replay. It preserves exact Architecture schema and inventory pins; source and content identity are rebound before acceptance. No runtime capability or release is activated.

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

- Draft `0.1.0-draft.11` aligns dataset and grader definition versions with their catalog declarations and exact file digests. Historical source pins remain available; fixture cases and grading policy are unchanged.

- The draft Primitive release advances to `0.1.0-draft.8` with retained PR
  evaluation-report artifacts.
- Source-Issue evaluation fixtures now exercise the GitHub Actions API path
  through a synthetic adapter and fail if the validator bypasses that adapter.
- The draft Primitive release advances to `0.1.0-draft.7` with the updated
  evaluation runner and dataset pins.
- The draft Primitive release advances to `0.1.0-draft.6` and consumes
  Architecture draft `0.1.0-draft.24` at
  `7b1d21462f70c411e75ae67ce80dcf688c9973e8`, pinning the evaluation report
  contract 2.0.0 by its exact schema digest.
- Evaluation reports now carry a registered case-selection policy, explicit
  case stimuli and outcomes, and evaluator identity, independence, and
  calibration evidence required by report contract 2.0.0.
- The prior draft Primitive release advanced to `0.1.0-draft.5` and pinned
  Architecture draft `0.1.0-draft.20` at
  `d6af08cf503b9dc06f6b0f706c843b23cfe61a3e`.
- Expanded the deterministic content digest to cover evaluation contracts,
  datasets, runner code, runtime pins, and the CI workflow.
- Preserved the draft4 Architecture draft3 pin so the Architecture-to-Primitive
  release graph remains acyclic.
- Draft4 consumes Architecture draft `0.1.0-draft.3` at
  `d4714c9489fb14824ef0967903d34a73c3e437fb`; draft3 consumes draft2 at
  `9b06a4e2202e851cdc700921828aac49d4a90d9d`.
- Draft2 records source commit `a39267da377328dbfb1ed210a23b2628c224bed6`,
  the Architecture Authority pin, and the canonical source digest.
- The initial draft Primitive release records the immutable source commit
  containing the extracted skill-boundary correction.

### Added

- Hosted pull-request evaluation now retains the schema-validated synthetic
  report as a 14-day artifact through a full-SHA-pinned upload action; a
  missing report fails validation.
- Added versioned synthetic datasets, pinned deterministic grader and baseline
  contracts, a manual-only semantic rubric, and replay reports validated
  against Architecture's immutable evaluation-report schema.
- Added offline replay of candidate and baseline repository-delivery validators;
  source-Issue cases use synthetic GitHub Actions API responses without live
  network or paid-model calls.
- Added independent semantic-review and adoption limitations to generated
  evaluation reports; findings point to the existing owner Issue without
  changing repository or Project state.
- Added the history-preserving extraction of reusable skills, the Codex
  delivery agent, and repository-delivery validators.
- Added primitive metadata, release, capability, and tool-policy contracts.
