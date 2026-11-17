// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

import { useCallback, useEffect, useState } from 'react';

/** Seconds a resend button stays disabled to keep users off the rate limit. */
export const RESEND_COOLDOWN_SECONDS = 60;

export type ResendCooldown = {
	cooldown: number;
	isCoolingDown: boolean;
	startCooldown: (seconds?: number) => void;
};

/**
 * Countdown state for "resend code" buttons.
 *
 * @param initialSeconds - Seconds to start at. Pass `0` when nothing has been
 *   sent yet, or the cooldown length when the flow arrives right after a send.
 */
export function useResendCooldown(initialSeconds = 0): ResendCooldown {
	const [cooldown, setCooldown] = useState(initialSeconds);

	useEffect(() => {
		if (cooldown <= 0) return;

		const interval = setInterval(() => {
			setCooldown((current) => (current > 0 ? current - 1 : 0));
		}, 1000);

		return () => clearInterval(interval);
	}, [cooldown]);

	// Stable so callers can start the cooldown from an effect without
	// re-running it on every render.
	const startCooldown = useCallback(
		(seconds = RESEND_COOLDOWN_SECONDS) => setCooldown(seconds),
		[],
	);

	return {
		cooldown,
		isCoolingDown: cooldown > 0,
		startCooldown,
	};
}
