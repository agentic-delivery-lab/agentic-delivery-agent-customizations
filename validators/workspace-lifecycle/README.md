# Workspace lifecycle guard

This validator implements the local ownership-lease and cleanup-admission part
of retained W21 under [Customizations #2](https://github.com/agentic-delivery-lab/agentic-delivery-agent-customizations/issues/2)
and [Architecture #7](https://github.com/agentic-delivery-lab/agentic-delivery-architecture/issues/7).
ADR-0004, ADR-0007 and AP-003 remain canonical in the exact Architecture release
selected by `manifests/primitive-release.json`.

## Supported profile

`linux-local-flock-v1` requires Linux, Python 3.12+, `/proc`, stock Git with
`--no-lazy-fetch` and `--no-replace-objects`, and util-linux `findmnt`. Local
ext2/ext3/ext4, Btrfs, XFS, tmpfs and overlay filesystems are admitted. Other
platforms, network filesystems and unknown filesystem types report a hold.
No dependency is downloaded by this module.

The repository and common Git storage must have a current-account-owned
ancestor with no group/other access. Common Git storage and the regular,
single-link lease file must have known current-account ownership and no
group/other write access. This profile covers one private OS account;
privileged host administration remains outside its trust boundary.

The stable lock is `<git-common-dir>/codex-workspace-lifecycle.lock`, matching
the existing personal profile convention. It is never unlinked or replaced.
Lease acquisition checks the open file's identity against the current path;
later admission rechecks it. This coordination is advisory. Unmodified Git,
Codex or other software can ignore the protocol; unknown or nonparticipating
consumers must block affected disposal. This module is not a security sandbox.

## Lease API

```python
with WorkspaceLease(repository, 'use', admitted_owner_id) as lease:
    subprocess.run(admitted_command, check=True, pass_fds=lease.child_fds())
```

`repository` locates a trusted local checkout, not a path supplied by Issue or
Project text. `admitted_owner_id` comes from the calling profile's task/session
ownership record; the module does not authenticate a supplied label.

`use` takes a shared OS lock. `cleanup` takes an exclusive, nonblocking lock.
Incompatible leases raise `WorkspaceHold` with structured `record()` evidence.
A live lease cannot be re-entered or converted. Use a new exclusive scope and
repeat discovery after ending a shared scope. Evidence is valid only while
the lease remains held.

`child_fds()` explicitly retains the same open description in a compatible
managed child. Closing the parent descriptor does not unlock a surviving
child's descriptor. Callers must verify inheritance for their actual execution
profile and settle all owned work before finishing. There is no assumption
that arbitrary Codex descendants retain an unrelated descriptor. A crash,
uncertain shutdown or unknown child disposition is a recovery hold.

When creating a linked task checkout, the admitted start caller must create its
Git worktree lock atomically using Git's supported `worktree add --lock --reason`
interface. Its reason is `agentic-workspace-v1 owner=<admitted_owner_id>`.
An existing unknown lock is preserved. The guard does not claim an unowned
workspace merely because it is unlocked, old, or has a familiar branch name.

## Read-only inventory and local admission

`read_inventory(repository)` returns schemaVersion 1 evidence containing the
primary checkout, registered worktrees, exact refs and stash object identities.
Worktree paths and lock reasons use `worktree list --porcelain -z`; file status
and ignored paths use NUL-delimited Git output. Missing or unreadable worktrees
remain explicitly unavailable. Discovery performs no fetch, repair or prune.
The fixed metadata queries reject stderr, including successful Git enumeration
that warns about unreadable directories. Exit status zero alone does not prove
complete traversal. Active bisect sessions are retained along with other
in-progress Git operations.

Under a live exclusive `WorkspaceLease`, call:

```python
local_cleanup_admission(
    lease,
    branch=admitted_branch,
    expected_tip=observed_task_tip,
    expected_default_tip=fresh_observed_default_tip,
    worktree=owned_task_worktree,  # None for a detached local-ref cleanup
    service_monitors=admitted_host_service_identities,
)
```

Tips are exact SHA-1 commit IDs. The caller must obtain the default observation
from its admitted hosting adapter and fetch without losing uniquely retained
refs before this check; cached local refs alone do not establish freshness.
The guard compares that observation to fetched `origin/main`, proves exact-tip
ancestry, and preserves default/release/support branches. A removal target must
be the registered sibling `<repo>.worktrees/<branch-with-slashes-replaced>` with
the expected branch, HEAD and exact owner lock. Primary removal, dirty/staged/
untracked files, in-progress Git operations and ignored artifacts all hold.
Assume-unchanged/skip-worktree flags, submodules and unresolved index stages
require explicit recovery. Tracked regular-file bytes and executable modes
are independently compared against raw indexed blobs with SHA-256, without
trusting stat caches, clean filters or line-ending conversions. Reads do not
follow directory/file links; tracked symlinks are compared as link text.
Redirected paths, hardlinks, changed files and unavailable blob snapshots hold.
The immutable blob batch is checked against an 8 MiB snapshot bound before
content retrieval. Transformed worktrees are retained when raw bytes differ.
Verified producer teardown must remove owned disposable artifacts before
admission; an ignore rule is not disposal authorization.

`consumer_probe` observes same-account cwd, descriptor, executable and mapped-file consumers without sending
signals. The invoking owner's primary-checkout cwd is allowed because the
primary is preserved. The invoking process and all its threads are inspected
too. Local admission exempts only its own live exclusive lease descriptor,
checking descriptor number, path and inode; other descriptors and mappings in
that process still block disposal. Direct observation has no lease exception
by default. Other active or uninspectable consumers hold. Protected
host service monitors require caller-admitted records containing exact pid,
kernel startTicks, uid, comm, cgroup and an explicit reason. Only known service
classes are eligible, and every identity is rechecked. Stale PID records never
become a general PID-ignore list. No exception is enabled by default. Ambiguous
newline/deleted-path mapping representations are checked conservatively in
both interpretations. Every thread's cwd and descriptors are inspected with
stable process/thread identities and a stable task set. A worker retaining a
file after its main thread exits remains observable. Linux thread groups share
an address space; one available nonempty mapping snapshot covers that group.
Thread churn, unavailable coverage or the 15-second observation deadline holds
cleanup rather than establishing a clean observation.
This snapshot cannot infer arbitrary future intentions
or anonymous heap references; managed callers must retain their verified use
leases and settle all owned work. Uncoordinated access is outside the admitted
protocol, not a universal guarantee supplied by stock Git or Codex.

The returned `locally-admissible` record has `hostingAuthorized: false`. It is
an observation, not a replayable cleanup permit. Keep the exclusive lease
through fresh checks and ordinary Git removal. The admitted caller must also
verify canonical repository identity, source ownership, merged PR and absence
of open PRs/active runs, protect changed remote tips with compare-and-delete,
and preserve unique refs before pruning. Those provider/authorization duties
remain with their existing owners. This module issues no GitHub mutation.

## Recovery and adoption

On a hold, preserve the checkout, branch, lock, unknown files and required
evidence. Reconcile the named owner or producer; repair a moved/corrupt
registration through an authorized recovery path, then repeat discovery.
Never force-remove a worktree, unlock another owner, reset/clean unknown work,
or use branch age or PR closure as integration proof.

Distribution must install an exact reviewed primitive/protocol pin in supported
CLI/service profiles. The Control Plane must integrate the same lease around
its managed start/use/finish path, including the existing branch starter.
Personal use, synthetic tests and this source artifact do not prove those
installations or organization-wide enforcement. Rollback disables the affected
managed mutation path and retains explicit manual checks and ownership evidence.

The Python tests use real Git worktrees, OS-lock contention, inherited file
descriptors, supervisor death and active/unreadable consumers. All repositories
in those temporary fixture directories are synthetic and have registered teardown.
