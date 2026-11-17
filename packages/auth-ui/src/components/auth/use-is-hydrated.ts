// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

import { useSyncExternalStore } from 'react';

/** No external store to subscribe to; the value only differs between server and client. */
const subscribeToNothing = (): (() => void) => () => {};

/**
 * Returns `true` once the component is mounted on the client (hydrated) and
 * `false` while rendering on the server, so client-only reads (e.g.
 * `sessionStorage`) stay safe during SSR.
 *
 * @returns Whether the component has hydrated on the client.
 */
export function useIsHydrated(): boolean {
	return useSyncExternalStore(
		subscribeToNothing,
		() => true,
		() => false,
	);
}
