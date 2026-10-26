---
name: Clean dependency validation
description: A package-manager resolver quirk that can make installed dependencies affect lockfile-only operations.
---

Do not assume npm's lockfile-only operation is isolated from an existing dependency installation.

**Why:** In this environment, npm 11 inspected pnpm-managed symlinks during lockfile-only resolution and failed inside its resolver. The same manifests resolved successfully without that installed dependency tree.

**How to apply:** For future package-manager transitions, validate resolution without the old manager's installed tree, then prove reproducibility with the new manager's clean-install command. Keep generated dependencies recoverable until the new lockfile is valid.
