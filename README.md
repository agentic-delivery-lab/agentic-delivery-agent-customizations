# Agentic Primitives

Agentic Primitives is the canonical source for reusable, versioned agents,
skills, instructions, hooks, validators, capabilities, and MCP/tool contracts.
The catalog and release manifests define each Primitive's path, version,
decision references, and immutable source evidence.

The architecture direction is one way:

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
ARCHITECTURE_AUTHORITY_ROOT=/path/to/agentic-delivery-architecture pnpm primitive:check
pnpm migration:check
pnpm test
```

Set `ARCHITECTURE_AUTHORITY_ROOT` to a Git checkout containing the pinned
Architecture commits when running the validator locally. CI checks out the
release-manifest commit directly.
