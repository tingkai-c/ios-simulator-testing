# Simulator harness agreements

Use Node 24+, Bun, and Python's standard library. Keep the agent-device dependency pinned and commit the Bun lockfile.

This repository and its Actions output are public. Workflows accept only public session metadata and recipient public keys. Private app builds, test inputs, captures, tokens, daemon state, and diagnostic logs stay in private runner temporary storage or on the client. Upload only the encrypted bootstrap artifact.

Read docs/privacy.md before changing transport, authentication, artifacts, or workflows. Preserve single-device sessions, absolute expiration, cleanup, and exact workflow-run identity checks. This is a prototype; report native validation separately from local tests.

Verify changes with node --test tests/*.test.mjs and python3 -m unittest discover -s tests -p 'test_*.py'. Run the synthetic native smoke workflow when changing simulator or transport behavior. Commit intent first, with useful Lore trailers.
