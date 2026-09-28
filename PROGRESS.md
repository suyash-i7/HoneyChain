Current Phase: 2 - Batch lifecycle and verification
Completed: Foundation plus constrained batch lifecycle, role-gated verifier queue, chain-gated decisions, audit events, and opt-in verifier/admin provisioning; production builds and integration tests pass.
Current: Verifier API and UI are implemented; beekeeper transition, access control, self-review rejection, and chain-proof checks are covered by SQLite integration tests.
Next: Run the updated workflow in the browser with a provisioned verifier, then implement evidence-based colony health and productivity analytics.
Blockers: Verifier credentials must be configured in ignored `.env` before browser review; three high npm audit advisories remain in Prisma's transitive `deepmerge-ts` dependency.