# Poyacity Release Control

This public repository is intentionally limited to **release approval control only**.

It contains no Poyacity Product source, build artifact, Production credential, provider secret, customer/user data, private deployment payload, or private repository history.

The `Poyacity Production Approval` workflow accepts only an exact 40-character Poyacity Product `main` commit SHA. Its approval job is bound to the `production-approval` GitHub Environment. The private Poyacity release workflow independently verifies the public repository identity, a pinned control commit, Environment protection rules, a successful exact approval run, OWNER actor, target SHA, and freshness before any Production mutation.

Do not add Product source, credentials, artifacts, or private repository history to this repository.
