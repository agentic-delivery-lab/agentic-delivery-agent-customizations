# Primitive metadata validator

[`validate-catalog.mjs`](validate-catalog.mjs) parses each inline
`agentic-primitive` block and checks it against the schema-validated catalog.
It also verifies every Architecture decision in the immutable release pin has
an affected Primitive/version mapping or an evidenced no-impact disposition.
Decision IDs include ADR, ADP, and ADD records; proposed Architecture records
must remain provisional until adopted. This validator reads pinned source and
does not store secrets, mutable runtime state, or publication credentials.

The independent semantic-review evidence is content-hashed and bound to the
exact Primitive catalog, cataloged Primitive source bytes, decision set, and
Architecture release pins. Any change to a cataloged Primitive source file
invalidates the evidence until it is reviewed and rebound. The validator checks
that evidence identity and integrity; it cannot prove the reviewer's reasoning
or confer human approval or Architecture decision adoption. A released
Primitive must use a released Architecture Authority release and contain no
provisional decision mappings.
