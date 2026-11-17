# Sign-in web capabilities

Provides the Web-compatible clock, deadlines, crypto and UUIDv7 source used by sign-in hosts. `createWebSignInCapabilities(clock, deadlines, crypto)` accepts each one injected; its default clock reads the runtime's `Date.now()`, and its default crypto is the runtime's `globalThis.crypto`, the only place a sign-in host reads it. IDs use that clock and are validated as UUIDv7 values.

The database factory and atomic runner belong to the host. Sign-in decisions and storage schema belong to [sign-in-core](../sign-in-core).

Central is supplied explicitly by each host: the `CENTRAL` binding on Cloudflare, or a private Unix socket on Node. This package provides no default provisioning stand-in.
