# Review hardening round 2

Scope: five reviewer findings on 1.0.22-beta.1.

1. P1 settings durability: `StateStore.update` must run the same normalization/validation as `save`; invalid data must never reach disk.
2. P2 protected replacement must not expose original as an Obsidian rename to `.tmp.backup`: copy original to backup, remove original, then no-overwrite create; restore by rename on failure.
3. P2 rollback must recognize plugin's partial install bytes and restore the good backup; preserve backup when a genuine user file exists.
4. P2 recovery must compare a content fingerprint captured before POST, protecting edits made while Obsidian is closed.
5. P2 transaction history search must request topological order so base cannot prematurely prove absence.

TDD: one focused failing regression per task first; production change only after RED. Full vitest/tsc/eslint/build; commit per logical task; final independent agent review.
