# Rollikey Enterprise Edition (`ee/`)

**All Rights Reserved — Closed Proprietary Software of Rollikey**

Copyright (c) 2026 Rollikey This directory is *not* open source. It is
governed solely by [`ee/LICENSE`](./LICENSE), not by the MIT license of
`packages/sdk` or the FSL-1.1-MIT license of `packages/server`.

## Reserved for Enterprise Edition

The following capabilities are reserved to the Enterprise Edition and will live
only in this directory:

- **SSO / SAML** — single sign-on and identity-provider federation.
- **RBAC permissions** — role-based access control over runs, reverts and airlock overrides.
- **Immutable SOC 2 audit logs** — tamper-evident, append-only audit trails.

Nothing outside `ee/` may import from `ee/`, and `ee/` code must never be
copied into `packages/sdk` or `packages/server`. Use of this code requires a
signed Enterprise Agreement with Rollikey
