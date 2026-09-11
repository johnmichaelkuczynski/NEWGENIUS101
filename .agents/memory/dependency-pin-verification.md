---
name: Dependency pin verification
description: Why dependency remediation must inspect both resolved lock entries and manifest version declarations.
---

After dependency auto-fixes, verify vulnerable exact versions across both lockfiles and manifest declarations. A clean ecosystem audit can coexist with a manifest range whose lower bound is a reported vulnerable release.

**Why:** Package managers may resolve a safe version in the current lockfile while leaving the vulnerable minimum in the manifest. A later clean install or scanner interpretation can surface the same finding again.

**How to apply:** Inventory manifests with a filesystem walk that prunes dependency, VCS, and build-output directories. Audit each lockfile-backed project independently, then compare every reported package/version pair against resolved lock entries and normalized manifest declarations.