---
"@openma/cli": patch
---

Emit `bundle_dir` and `fresh` on `session.ready` after a fresh ACP spawn so the cloud harness can locate the platform bundle without guessing scratch paths.
