# Agentic Primitives

Agentic Primitives are reusable, versioned capabilities for the organization:
agents, skills, instructions, hooks, deterministic validators, capability
catalogs, and MCP/tool contracts.

The architecture direction is one way:

```text
Architecture Authority -> Agentic Primitives -> approved distribution surfaces
                                       -> Delivery Control Plane selection
```

The organization Copilot agents published from `.github-private/agents` are
promoted projections from this repository unless a separate architecture
decision explicitly scopes an organization-only agent to that private surface.

Offline evaluations are versioned under `evaluations/`. Their datasets contain
synthetic fixtures, deterministic graders replay pinned validator blobs, and a
separate semantic rubric is manual-only. Reports validate against the immutable
Architecture Authority contract pin in the Primitive release manifest. Replay
uses an injected synthetic GitHub Actions API adapter for source-Issue cases;
it makes no live GitHub or model-service calls and cannot write Issues,
Projects, or policy state. This draft evaluation mechanism is not adopted as
a catalogued Primitive until Architecture Issue #11 is reviewed and merged
and Primitive Issue #2 completes its ADR impact mapping.

This local repository is a history-preserving extraction prepared for review;
remote repository creation and organization publication remain operator steps.

```text
pnpm primitive:check
pnpm migration:check
pnpm evaluation:check
pnpm test
```
