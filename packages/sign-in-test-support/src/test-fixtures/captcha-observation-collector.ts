import {
	signInObservationSchema,
	type SignInObservation,
	type Uuid7,
} from '@agent-collaboration/sign-in-core';
import type { WorkerdStructuredLog } from 'miniflare';

import { captchaObservationDrainSchema } from '#sign-in-test-support/test-fixtures/captcha-observation-control';

export interface CaptchaObservationCollector {
	readonly handleStructuredLog: (entry: WorkerdStructuredLog) => void;
	readonly waitForDrain: (requestId: Uuid7) => Promise<void>;
	readonly observations: () => readonly SignInObservation[];
}

/** Uses Miniflare's supported stream callback. It ignores runtime timestamps;
 * an explicit later marker establishes delivery without a sleep or poll. */
export function createCaptchaObservationCollector(): CaptchaObservationCollector {
	const observations: SignInObservation[] = [];
	const drains = new Map<Uuid7, PromiseWithResolvers<void>>();
	return {
		handleStructuredLog(entry: WorkerdStructuredLog): void {
			let payload: unknown;
			try {
				payload = JSON.parse(entry.message);
			} catch {
				return;
			}
			const observation = signInObservationSchema.safeParse(payload);
			if (observation.success) {
				observations.push(observation.data);
				return;
			}
			const marker = captchaObservationDrainSchema.safeParse(payload);
			if (!marker.success) return;
			const pending = drains.get(marker.data.requestId);
			if (pending !== undefined) {
				pending.resolve();
				drains.delete(marker.data.requestId);
			}
		},
		waitForDrain(requestId: Uuid7): Promise<void> {
			const existing = drains.get(requestId);
			if (existing !== undefined) return existing.promise;
			const pending = Promise.withResolvers<void>();
			drains.set(requestId, pending);
			return pending.promise;
		},
		observations(): readonly SignInObservation[] {
			return observations.slice();
		},
	};
}
