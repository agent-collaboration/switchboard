// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useIsMobile } from '@tool-access-ui/hooks/use-mobile';
import { afterEach, expect, it, vi } from 'vitest';

afterEach((): void => {
	cleanup();
	vi.unstubAllGlobals();
});

// The sidebar's existing breakpoint is 768px. Keep the real hook and React
// subscription lifecycle; only the browser viewport and media events are controlled.
it('tracks both sides of the mobile breakpoint and removes its subscription', (): void => {
	const mediaQuery = new EventTarget();
	const subscribe = vi.spyOn(mediaQuery, 'addEventListener');
	const unsubscribe = vi.spyOn(mediaQuery, 'removeEventListener');
	vi.stubGlobal('innerWidth', 767);
	vi.stubGlobal('matchMedia', (): EventTarget => mediaQuery);
	const { result, unmount } = renderHook(useIsMobile);
	expect(result.current).toBe(true);
	expect(subscribe).toHaveBeenCalledTimes(1);
	act((): void => {
		vi.stubGlobal('innerWidth', 768);
		mediaQuery.dispatchEvent(new Event('change'));
	});
	expect(result.current).toBe(false);
	act((): void => {
		vi.stubGlobal('innerWidth', 767);
		mediaQuery.dispatchEvent(new Event('change'));
	});
	expect(result.current).toBe(true);
	unmount();
	expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('change', subscribe.mock.calls[0]?.[1]);
});
