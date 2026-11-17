// Third-party notices: THIRD_PARTY_NOTICES.md#shadcn-ui (repository root).
import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

function subscribeToMobileBreakpoint(onChange: () => void): () => void {
	const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
	mediaQuery.addEventListener('change', onChange);
	return () => mediaQuery.removeEventListener('change', onChange);
}

function readMobileBreakpoint(): boolean {
	return window.innerWidth < MOBILE_BREAKPOINT;
}

function readServerMobileBreakpoint(): boolean {
	return false;
}

export function useIsMobile(): boolean {
	return React.useSyncExternalStore(
		subscribeToMobileBreakpoint,
		readMobileBreakpoint,
		readServerMobileBreakpoint,
	);
}
