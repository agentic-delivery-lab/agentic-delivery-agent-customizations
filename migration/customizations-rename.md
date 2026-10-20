# Repository-name migration: Agent Customizations

Source work: organization implementation plan W05 and this repository's Issue #2.
This is a preparation record. The hosting rename and consumer cutover have not
occurred, and this record does not activate a participant or approve a release.

## Identity and unchanged contracts

The owner-selected destination is
`agentic-delivery-lab/agentic-delivery-agent-customizations`. The repository being
renamed is `agentic-delivery-lab/agentic-delivery-primitives`, GitHub repository
ID `1380894656`. Immediately before and after the hosting rename, read back the
repository ID and require an exact match. The destination must be unoccupied
before the change. Do not reuse the old name for another repository.

The `agentic-primitives` domain context, primitive URNs, release IDs, source
commits and historical decision origins retain their meaning. Agent
Customizations names the repository responsibility; it does not replace the
domain context or create a new one. Distribution remains a separate owner.

## Caller cutover

Prepare current-name changes before the hosting operation. Current callers
include Control Plane participant identity, selection and publication
validators; Architecture checkout and current context locations; Distribution
source locks and projection generation; and the private adapter's source
checkout and provenance. The public adapter has no direct old-name caller on
the inventoried default branch. Recheck this inventory at cutover.

Keep exact repository-ID admission for the participant. An old-name redirect
is not the acceptance test for a current caller. Test the explicit destination
name, exact source revision and digest, and recheck access with the admitted
identity. Keep participants shadow throughout the migration.

Historical migration manifests, schema identifiers, ADR origins and already
pinned release artifacts are not current-name configuration. Preserve their
bytes and hashes. Where a consumer still admits an immutable artifact naming
the old repository, add an explicit, reviewed identity-bound compatibility
rule; never accept an arbitrary repository with the old name. Regenerate new
release metadata from its actual prepared source rather than editing a frozen
artifact in place.

## Local work and rollback

Existing checkouts and worktrees may retain their old filesystem names while
they are in use. Update owned remote URLs to the explicit destination without
moving another session's checkout. Preserve open Issue/PR numbers, dirty work,
leases and worktree locks. Integrate the existing impact and evaluation PRs by
their exact heads; do not overwrite their working directories.

If identity, access, digest or a current caller cannot be verified, suspend the
participant and stop cutover. Restore the previous supported consumer
composition, preserving evidence and all dirty work. Reverse a hosting name
change only after checking both name occupancy and unchanged repository ID;
do not rely on a redirect or reclaim a name occupied by another identity.

Acceptance requires the hosting readbacks, known-caller tests, unchanged
canonical identities and retained historical provenance. Preparation of this
record alone is not W05 completion or factory-delivered Milestone A evidence.
