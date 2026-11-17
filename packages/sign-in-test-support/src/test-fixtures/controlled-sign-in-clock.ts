import { epochMillisecondsSchema, type SignInClock } from '@agent-collaboration/sign-in-core';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';

import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';

export const controlledSignInClock: SignInClock = {
	now: () => epochMillisecondsSchema.parse(initialSignInTestTime),
};
export const controlledSignInIds = createWebSignInCapabilities(controlledSignInClock).ids;

/** Test bundles mock the runtime Date API; production bundles are never changed. */
export function controlledWorkerDateScript(): string {
	const milliseconds = controlledSignInClock.now();
	return `globalThis.Date = new Proxy(Date, {
 apply(target) { return Reflect.construct(target, [${milliseconds}]).toString(); },
 construct(target, args) { return Reflect.construct(target, args.length === 0 ? [${milliseconds}] : args); },
 get(target, key, receiver) { return key === 'now' ? () => ${milliseconds} : Reflect.get(target, key, receiver); }
});`;
}
