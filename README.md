# Agent Customizations

Agent Customizations is the canonical source for reusable, versioned agents,
skills, instructions, hooks, validators, capabilities, and MCP/tool contracts.
The catalog and release manifests define each Primitive's path, version,
decision references, and immutable source evidence.

The bounded context remains `agentic-primitives`; the hosting rename preserves
repository ID `1380894656`. Current evaluation candidate references use
`agentic-delivery-agent-customizations`. Immutable historical baseline pins
and stable contract identifiers retain their original names.

The current draft candidate selects Architecture draft.77 and covers all 24
decision records. Five proposed-origin impact rows remain provisional; neither
that draft pin nor the automated delivery-role instructions admit a runtime
context or activate a participant. Requirements approval and controller context
admission remain separate from reference coverage.

The architecture direction is one way:

Offline evaluations under `evaluations/` use synthetic fixtures and deterministic
graders over pinned validator blobs. A separate semantic rubric is manual-only.
Replay uses an injected GitHub Actions API adapter, makes no live GitHub or
model-service calls, and cannot write Issues, Projects or policy. Reports bind
the exact Architecture schema bytes and candidate/baseline source commits.
CI retains the schema-validated synthetic report for 14 days. This source
integration does not admit evaluation tooling as a runtime capability or prove
production improvement.

The [workspace lifecycle guard](validators/workspace-lifecycle/README.md)
provides shared/exclusive ownership leases, read-only Git inventory and local
cleanup observations for a private-account Linux profile. It uses stock Git
and OS interfaces. Fresh hosting authorization, installation and caller
integration remain separate; a catalog entry grants no execution permission.
On Linux, `pnpm test` also runs its real Git/process tests using Python 3.12+
and util-linux `findmnt`. Other platforms explicitly skip that profile's tests.

```text
Architecture Authority -> Agentic Primitives -> approved distribution surfaces
                                       -> Delivery Control Plane selection
```

Copilot agents published from `.github-private/agents` are promoted from
`agents/copilot/` through the publication lock in the Distribution repository.
The `adrs` metadata field remains the ADR-only projection consumed by existing
Architecture and Distribution checks; `decisionIds` also records ADP and ADD
decisions for complete release impact review.

Architecture Authority is read from the exact release-manifest commit and
source commit in `manifests/primitive-release.json`. The catalog validator
checks that pin and the impact review before a release can advance. Publication
to consumer surfaces remains a separate reviewed operation.

```text
pnpm install --frozen-lockfile
export ARCHITECTURE_AUTHORITY_ROOT=/path/to/agentic-delivery-architecture
pnpm primitive:check
pnpm migration:check
pnpm evaluation:check
pnpm test
```

Set `ARCHITECTURE_AUTHORITY_ROOT` for all local checks to a Git checkout
containing the pinned Architecture commits. Evaluation replay reads its schema
from that root and still verifies the pinned schema digest. The optional
`ARCHITECTURE_REPORT_SCHEMA` file path takes precedence when explicitly set;
when neither setting is provided, replay uses the sibling Architecture
checkout. CI checks out the release-manifest commit directly.

Integrate prepared releases with a merge commit. The prepared source must
remain an ancestor of the reviewed head and accepted main; squash or rebase
can discard the pinned source object required by catalog validation and replay.
