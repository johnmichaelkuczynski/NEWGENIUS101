---
name: Usage access tiers
description: The project’s staged access model and payment boundary.
---

Keep the full site publicly visible and usable without authentication. Allow four anonymous generation operations, then offer real Google OAuth. Give authenticated unpaid users seventeen additional operations, then present the payment step. Full-access users are not metered.

**Why:** Prospects must experience intact functionality before deciding to sign in or pay; a site-wide login wall prevents evaluation and conversion.

**How to apply:** Gate only generation operations, never page access or browsing. Present access transitions as positive continuation prompts, not application errors. Do not install or simulate Stripe until the owner explicitly supplies the payment setup through the secure workspace flow.

Keep unsaved source files and previous output available when an access limit prevents a new generation. For a form holding an unsaved uploaded file, open Google login in a separate top-level tab rather than navigating the source tab away.

**Why:** A full-page OAuth navigation destroys in-memory uploaded File objects. A clearer access prompt must not introduce source loss, and a broken login must not be worked around by silently removing the owner's access limits.

**How to apply:** Preserve the source tab, let the user return after authenticating, and distinguish a reproduced response-handling defect from proof of what happened in a particular historical production request.