<!-- agentic-primitive: {"id":"delivery-workflow","kind":"skill","enforcement":"instructional","decisionIds":["ADR-0004","ADR-0005","ADR-0006","ADR-0007","ADR-0008"],"domains":["agentic-delivery-governance"],"adrs":["ADR-0004","ADR-0005","ADR-0006","ADR-0007","ADR-0008"]} -->

---
name: delivery-workflow
description: Apply this repository's trunk-based delivery, Conventional Commits, Gitmoji and curated changelog rules when planning, changing or reviewing delivery work.
---

# Delivery workflow

Use this skill when a change affects the repository's branch workflow, commit history, pull requests, releases or `CHANGELOG.md`.

## Establish repository context

Before making a domain-bearing change, read [`references/architecture-authority.md`](../../references/architecture-authority.md), resolve the immutable Architecture Authority commit from `manifests/primitive-release.json`, and read its `architecture/domain/README.md` and `architecture/domain/ubiquitous-language.yml`. Use the `agentic-delivery-governance` bounded context and its registered terms. A missing concept, conflicting meaning or changed definition is a domain-model change and must be updated in the same change set.

For an architectural choice, resolve and read `decisions/README.md` and the ADR template from that same Architecture commit, then use `$architecture-decision`. An architecture decision record is provisional on a feature branch and becomes an official decision only after its review pull request is merged into `main`.

## Work from the trunk

- Keep `main` deployable and use a short-lived feature branch for each change.
- Branch from the current `main`; keep the branch's pull-request head separate from `main`, which is the protected base. Use `pnpm branch:start <type> <issue-number> <summary>` from a clean, synchronized `main` so the supported path verifies an open source issue before creating an issue-linked branch. Names use `<type>/issue-<number>-<lowercase-kebab-case-summary>`. Never open a pull request with `main` as its head.
- Finish a feature branch within two calendar days when practical. Integrate through a review pull request as soon as the change is complete.
- Do not create `develop`, permanent feature or permanent release branches for ordinary work. Use a feature flag when incomplete work must be integrated early.
- A coding agent may prepare, push and update a branch or review pull request, but it must not merge the pull request, bypass protection or close the source issue without explicit human authorization.
- The repository's chosen merge method is a merge commit. Do not use squash, rebase or auto-merge for this workflow. Delete a merged feature branch after a human has completed the merge.

Use the organization pull request template published by
`agentic-delivery-lab/.github`; this repository must not carry a local
override. Keep `## Source` and `## Plan` as separate headings: put the source
issue under `Source`, and the implementation plan and deviations under `Plan`.
Complete every section and replace placeholders with concise
evidence. Link the source issue and implementation plan, explain every material
plan deviation, report verification, assess risk and rollback, and guide the
reviewer. Use `Not applicable` only with a reason. The deterministic
`Validate pull request body` check applies to people and coding agents. Only a
pull request authored by `dependabot[bot]` is explicitly exempt; do not broaden
that exception to another bot, app, user, or team.

The versioned main-branch ruleset requires this check. The repository is public,
but the rule remains policy until an authorized maintainer applies it after the
workflow is on `main` and verifies the live repository ruleset through GitHub.
Do not claim live enforcement from the JSON file alone.

The branch starter rejects a closed, missing or unreadable source issue and rejects a pull request number even when it is open. Use `pnpm lint:branch <branch-name>` for a candidate that already exists. CI repeats the branch syntax and open-issue checks when an internal pull request is opened or updated. A raw Git branch command can bypass the local helper, but it cannot pass the pull-request check with an invalid name or source issue.

## Coordinate workspace ownership

Follow the workspace lifecycle in the pinned ADR-0004 and filesystem projection
in ADR-0007. The [workspace guard](../../validators/workspace-lifecycle/README.md)
implements a local Linux profile for admitted managed callers. Its catalog
entry does not grant execution permission or establish installation.

- Inventory the primary checkout, every registered worktree, refs, stashes and
  unknown files before starting or recovering work. Prefer a clean primary for
  sequential work. Preserve dirty or unknown-owned work; do not create another
  checkout to escape it.
- A managed caller holds the shared common-Git ownership lease throughout use.
  Create isolated task checkouts only in the canonical sibling container and
  use an owner-identified native worktree lock. Verify actual child descriptor
  inheritance and settle owned processes before ending the lease; stock Codex
  does not establish this protocol automatically.
- Before disposal, end the shared scope, acquire an exclusive lease and repeat
  discovery. A missing lease, unknown consumer, unreadable worktree, changed
  tip, dirty/ignored artifact or unsupported profile holds the affected action.
  Never delete or replace the common lease file, force removal, unlock another
  owner, or reset/clean unknown work.
- Obtain fresh canonical hosting identity, open-PR and active-run observations.
  Preserve unique commits before fetching/pruning; compare the exact task tip
  with the current fetched default. Hold the exclusive lease through final
  checks and normal Git removal, and use an expected-tip guard for remote
  deletion. PR closure and branch age do not prove integration.
- On completion, report removed items, active work and preservation reasons.
  An uncertain shutdown requires recovery evidence before disposal.

The guard's local observation has `hostingAuthorized: false`; it performs no
GitHub mutation or removal. Distribution installation and Control Plane caller
integration remain separate evidence requirements. Unsupported platforms keep
the managed mutation path disabled and require the explicit manual procedure.

## Write commit and pull-request titles

Use the Conventional Commits grammar with the type first:

```text
<type>[optional scope][optional !]: <description>
```

This repository places a Gitmoji immediately after the Conventional Commit prefix, for example:

```text
feat(delivery): ✨ establish trunk-based delivery
```

The emoji may be the official Unicode character or its official Gitmoji shortcode. This ordering is an intentional local mapping: Conventional Commits remains parseable while Gitmoji supplies the intent marker. Validate every non-merge commit in the review pull request and validate the pull-request title with the same contract. Historical commits are not rewritten; merge commits are ignored by commitlint's default rule.

Keep the description short and explain why in the body when needed. Use a breaking-change marker (`!` or a `BREAKING CHANGE:` footer) only when the change really breaks consumers. Keep exact external names, identifiers and quotations unchanged and explain their context when they differ from the repository vocabulary.

## Maintain the changelog

Keep this repository's [`CHANGELOG.md`](../../CHANGELOG.md) curated for people. Add user-relevant changes under `[Unreleased]` and use the Keep a Changelog categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security`. Do not generate a raw commit dump, invent a release date or create a tag or release as part of ordinary feature work. A release is a separate, explicitly authorized human action using a SemVer version and an ISO 8601 date.

Review whether a change belongs in the changelog and whether its wording is useful to readers; the validator can check structure, not relevance or meaning.

## Structural checks and semantic review

The delivery-quality workflow structurally checks commit syntax and Gitmoji mappings, changelog shape, Markdown, YAML, JSON, repository tests and dependency audit results. These checks do not prove that a commit type, Gitmoji, changelog entry or domain term is semantically correct. Agents and human reviewers must review intent, affected bounded contexts, plain-language documentation, branch age and release impact.

## Sources

- [Trunk Based Development](https://trunkbaseddevelopment.com/)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [`@commitlint/config-conventional`](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional)
- [Gitmoji](https://gitmoji.dev/)
- [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
