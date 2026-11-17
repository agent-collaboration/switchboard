import {
	oauthAccountIdSchema,
	type OAuthBrowserSessionIdentity,
} from '@agent-collaboration/oauth-broker-contracts';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	createOAuthBrowserNavigationStore,
	type OAuthBrowserNavigationCreation,
	type OAuthBrowserNavigationStore,
} from './oauth-browser-navigation-store.js';
import { differentSecret } from './oauth-ceremony-hegel-fixture.js';
import {
	createOAuthLoginContinuationStore,
	type OAuthLoginContinuationCreation,
	type OAuthLoginContinuationStore,
	type OAuthLoginContinuationTarget,
} from './oauth-login-continuation-store.js';

const browserLifetimeMs = 10 * 60_000;
const propertySettings = {
	testCases: 100,
	seed: 20261117,
	derandomize: true,
	database: hegel.Database.disabled,
};
const principals: readonly OAuthBrowserSessionIdentity[] = [
	{ issuer: 'https://identity.example.test', subject: 'synthetic-owner' },
	{ issuer: 'https://identity.example.test', subject: 'other-synthetic-owner' },
	{ issuer: 'https://other-identity.example.test', subject: 'synthetic-owner' },
];
const targets: readonly OAuthLoginContinuationTarget[] = [
	{ kind: 'agents' },
	{
		kind: 'account',
		agentId: 'hermes',
		accountId: oauthAccountIdSchema.parse('018f0d10-3ef0-7c65-8ace-111111111111'),
	},
];

interface ContinuationEntry {
	readonly handle: Extract<OAuthLoginContinuationCreation, { readonly kind: 'created' }>;
	readonly target: OAuthLoginContinuationTarget;
	readonly expiresAtMs: number;
	retained: boolean;
}
interface ContinuationState {
	readonly store: OAuthLoginContinuationStore;
	readonly clock: { nowMs: number };
	readonly capacity: number;
	readonly entries: ContinuationEntry[];
}

function createContinuation(
	state: ContinuationState,
	target: OAuthLoginContinuationTarget,
): ContinuationEntry | undefined {
	for (const entry of state.entries)
		if (entry.expiresAtMs <= state.clock.nowMs) entry.retained = false;
	const actual = state.store.create(target);
	if (
		state.entries.filter((entry: ContinuationEntry): boolean => entry.retained).length >=
		state.capacity
	) {
		expect(actual).toEqual({ kind: 'capacity-exhausted' });
		return undefined;
	}
	if (actual.kind !== 'created') throw new Error('Continuation below model capacity was refused.');
	expect(actual.expiresAtMs).toBe(state.clock.nowMs + browserLifetimeMs);
	const entry: ContinuationEntry = {
		handle: actual,
		target,
		expiresAtMs: state.clock.nowMs + browserLifetimeMs,
		retained: true,
	};
	state.entries.push(entry);
	return entry;
}

function consumeContinuation(props: {
	readonly state: ContinuationState;
	readonly entry: ContinuationEntry;
	readonly identity: OAuthBrowserSessionIdentity;
	readonly secret: string;
}): void {
	const { state, entry, identity, secret } = props;
	const actual = state.store.consume({
		continuationId: entry.handle.continuationId,
		browserBindingSecret: secret,
		identity,
	});
	if (!entry.retained) expect(actual).toEqual({ kind: 'missing' });
	else if (entry.expiresAtMs <= state.clock.nowMs) {
		expect(actual).toEqual({ kind: 'expired' });
		entry.retained = false;
	} else if (secret !== entry.handle.browserBindingSecret)
		expect(actual).toEqual({ kind: 'browser-mismatch' });
	else {
		// There is no principal until login: the newly verified identity is the accepted one.
		expect(actual).toEqual({ kind: 'accepted', identity, target: entry.target });
		entry.retained = false;
	}
}

function assertContinuations(state: ContinuationState): void {
	for (const entry of state.entries) {
		const input = {
			continuationId: entry.handle.continuationId,
			browserBindingSecret: entry.handle.browserBindingSecret,
		};
		expect(state.store.isActive(input)).toBe(
			entry.retained && entry.expiresAtMs > state.clock.nowMs,
		);
		expect(
			state.store.isActive({
				...input,
				browserBindingSecret: differentSecret(input.browserBindingSecret),
			}),
		).toBe(false);
	}
	expect(
		state.entries.filter((entry: ContinuationEntry): boolean => entry.retained).length,
	).toBeLessThanOrEqual(state.capacity);
}

const continuationMachine: hegel.stateful.StateMachine<ContinuationState> = {
	rules: {
		create: (testCase: hegel.TestCase, state: ContinuationState): void => {
			createContinuation(state, testCase.draw(generators.sampledFrom(targets)));
		},
		consume: (testCase: hegel.TestCase, state: ContinuationState): void => {
			if (state.entries.length === 0) return;
			const entry = testCase.draw(generators.sampledFrom(state.entries));
			const fault = testCase.draw(generators.sampledFrom(['none', 'other-browser', 'malformed']));
			const secret =
				fault === 'none'
					? entry.handle.browserBindingSecret
					: fault === 'malformed'
						? 'short'
						: differentSecret(entry.handle.browserBindingSecret);
			const identity = testCase.draw(generators.sampledFrom(principals));
			testCase.note(
				JSON.stringify({ fault, identity, retained: entry.retained, nowMs: state.clock.nowMs }),
			);
			consumeContinuation({ state, entry, identity, secret });
		},
		advanceClock: (testCase: hegel.TestCase, state: ContinuationState): void => {
			const entry =
				state.entries.length === 0
					? undefined
					: testCase.draw(generators.sampledFrom(state.entries));
			state.clock.nowMs = Math.max(
				state.clock.nowMs,
				(entry?.expiresAtMs ?? state.clock.nowMs + browserLifetimeMs) +
					testCase.draw(generators.sampledFrom([-1, 0, 1])),
			);
			testCase.note(`nowMs=${state.clock.nowMs}`);
		},
		clear: (_testCase: hegel.TestCase, state: ContinuationState): void => {
			state.store.clear();
			for (const entry of state.entries) entry.retained = false;
		},
	},
	invariants: {
		browserBoundFirstUseAndFixedExpiry: {
			alwaysCheck: true,
			check: (_testCase: hegel.TestCase, state: ContinuationState): void =>
				assertContinuations(state),
		},
	},
};

it('M2 login continuations bind the browser secret, consume once and enforce capacity and exact expiry', async (): Promise<void> => {
	await hegel.testAsync(async (testCase: hegel.TestCase): Promise<void> => {
		// Arrange
		const clock = { nowMs: 1_000 };
		const capacity = testCase.draw(generators.integers({ minValue: 1, maxValue: 4 }));
		const state: ContinuationState = {
			clock,
			capacity,
			entries: [],
			store: createOAuthLoginContinuationStore({ now: (): number => clock.nowMs, capacity }),
		};
		testCase.note(`capacity=${capacity}`);
		for (let index = 0; index <= capacity; index++)
			createContinuation(state, testCase.draw(generators.sampledFrom(targets)));
		const first = state.entries[0];
		if (first === undefined)
			throw new Error('Continuation capacity setup did not create an entry.');
		const identity = testCase.draw(generators.sampledFrom(principals));
		for (const secret of [differentSecret(first.handle.browserBindingSecret), 'short', ''])
			consumeContinuation({ state, entry: first, identity, secret });
		consumeContinuation({
			state,
			entry: first,
			identity,
			secret: first.handle.browserBindingSecret,
		});
		consumeContinuation({
			state,
			entry: first,
			identity,
			secret: first.handle.browserBindingSecret,
		});
		const replacement = createContinuation(state, { kind: 'agents' });
		if (replacement === undefined) throw new Error('First use must free continuation capacity.');
		clock.nowMs = replacement.expiresAtMs - 1;
		assertContinuations(state);
		clock.nowMs++;
		consumeContinuation({
			state,
			entry: replacement,
			identity,
			secret: replacement.handle.browserBindingSecret,
		});
		consumeContinuation({
			state,
			entry: replacement,
			identity,
			secret: replacement.handle.browserBindingSecret,
		});
		// Act / Assert
		await hegel.stateful.runAsync(testCase, continuationMachine, state, { stepCount: 50 });
	}, propertySettings);
});

interface NavigationEntry {
	readonly handle: Extract<OAuthBrowserNavigationCreation, { readonly kind: 'created' }>;
	readonly identity: OAuthBrowserSessionIdentity;
	readonly target: OAuthLoginContinuationTarget;
	readonly expiresAtMs: number;
	retained: boolean;
}
interface NavigationState {
	readonly store: OAuthBrowserNavigationStore;
	readonly clock: { nowMs: number };
	readonly capacity: number;
	readonly entries: NavigationEntry[];
}

function createNavigation(props: {
	readonly state: NavigationState;
	readonly identity: OAuthBrowserSessionIdentity;
	readonly target: OAuthLoginContinuationTarget;
}): NavigationEntry | undefined {
	const { state, identity, target } = props;
	for (const entry of state.entries)
		if (entry.expiresAtMs <= state.clock.nowMs) entry.retained = false;
	const actual = state.store.create({ identity, target });
	if (
		state.entries.filter((entry: NavigationEntry): boolean => entry.retained).length >=
		state.capacity
	) {
		expect(actual).toEqual({ kind: 'capacity-exhausted' });
		return undefined;
	}
	if (actual.kind !== 'created')
		throw new Error('Navigation context below model capacity was refused.');
	expect(actual.expiresAtMs).toBe(state.clock.nowMs + browserLifetimeMs);
	const entry: NavigationEntry = {
		handle: actual,
		identity,
		target,
		expiresAtMs: state.clock.nowMs + browserLifetimeMs,
		retained: true,
	};
	state.entries.push(entry);
	return entry;
}

function readNavigation(state: NavigationState, entry: NavigationEntry, secret: string): void {
	const actual = state.store.read({
		contextId: entry.handle.contextId,
		browserBindingSecret: secret,
	});
	if (entry.expiresAtMs <= state.clock.nowMs) entry.retained = false;
	if (!entry.retained || secret !== entry.handle.browserBindingSecret)
		expect(actual).toBeUndefined();
	else
		expect(actual).toEqual({
			identity: entry.identity,
			target: entry.target,
			expiresAtMs: entry.expiresAtMs,
			browserBindingSecret: entry.handle.browserBindingSecret,
			csrfToken: entry.handle.csrfToken,
		});
}

function cancelNavigation(state: NavigationState, identity: OAuthBrowserSessionIdentity): void {
	state.store.cancelSession(identity);
	for (const entry of state.entries)
		if (entry.identity.issuer === identity.issuer && entry.identity.subject === identity.subject)
			entry.retained = false;
}

function assertNavigation(state: NavigationState): void {
	for (const entry of state.entries) {
		readNavigation(state, entry, differentSecret(entry.handle.browserBindingSecret));
		readNavigation(state, entry, entry.handle.browserBindingSecret);
		// Reads are repeatable, and they never move the expiry deadline.
		readNavigation(state, entry, entry.handle.browserBindingSecret);
	}
	expect(
		state.entries.filter((entry: NavigationEntry): boolean => entry.retained).length,
	).toBeLessThanOrEqual(state.capacity);
}

const navigationMachine: hegel.stateful.StateMachine<NavigationState> = {
	rules: {
		create: (testCase: hegel.TestCase, state: NavigationState): void => {
			createNavigation({
				state,
				identity: testCase.draw(generators.sampledFrom(principals)),
				target: testCase.draw(generators.sampledFrom(targets)),
			});
		},
		read: (testCase: hegel.TestCase, state: NavigationState): void => {
			if (state.entries.length === 0) return;
			const entry = testCase.draw(generators.sampledFrom(state.entries));
			const matchingSecret = testCase.draw(generators.booleans());
			testCase.note(JSON.stringify({ matchingSecret, retained: entry.retained }));
			readNavigation(
				state,
				entry,
				matchingSecret
					? entry.handle.browserBindingSecret
					: differentSecret(entry.handle.browserBindingSecret),
			);
		},
		cancelSession: (testCase: hegel.TestCase, state: NavigationState): void => {
			const identity = testCase.draw(generators.sampledFrom(principals));
			testCase.note(JSON.stringify({ identity }));
			cancelNavigation(state, identity);
		},
		advanceClock: (testCase: hegel.TestCase, state: NavigationState): void => {
			const entry =
				state.entries.length === 0
					? undefined
					: testCase.draw(generators.sampledFrom(state.entries));
			state.clock.nowMs = Math.max(
				state.clock.nowMs,
				(entry?.expiresAtMs ?? state.clock.nowMs + browserLifetimeMs) +
					testCase.draw(generators.sampledFrom([-1, 0, 1])),
			);
			testCase.note(`nowMs=${state.clock.nowMs}`);
		},
		clear: (_testCase: hegel.TestCase, state: NavigationState): void => {
			state.store.clear();
			for (const entry of state.entries) entry.retained = false;
		},
	},
	invariants: {
		principalCancellationBrowserBindingAndFixedExpiry: {
			alwaysCheck: true,
			check: (_testCase: hegel.TestCase, state: NavigationState): void => assertNavigation(state),
		},
	},
};

it('M2 post-login navigation sessions bind principals and browsers without first-read consumption or renewal', async (): Promise<void> => {
	await hegel.testAsync(async (testCase: hegel.TestCase): Promise<void> => {
		// Arrange
		const clock = { nowMs: 1_000 };
		const capacity = testCase.draw(generators.integers({ minValue: 1, maxValue: 4 }));
		const state: NavigationState = {
			clock,
			capacity,
			entries: [],
			store: createOAuthBrowserNavigationStore({ now: (): number => clock.nowMs, capacity }),
		};
		testCase.note(`capacity=${capacity}`);
		const identity = principals[0];
		if (identity === undefined) throw new Error('Literal navigation principal is missing.');
		for (let index = 0; index <= capacity; index++)
			createNavigation({ state, identity, target: testCase.draw(generators.sampledFrom(targets)) });
		for (const otherIdentity of principals.slice(1)) {
			cancelNavigation(state, otherIdentity);
			assertNavigation(state);
		}
		cancelNavigation(state, identity);
		const replacement = createNavigation({ state, identity, target: { kind: 'agents' } });
		if (replacement === undefined)
			throw new Error('Principal cancellation must free navigation capacity.');
		clock.nowMs = replacement.expiresAtMs - 1;
		assertNavigation(state);
		clock.nowMs++;
		assertNavigation(state);
		// Act / Assert
		await hegel.stateful.runAsync(testCase, navigationMachine, state, { stepCount: 50 });
	}, propertySettings);
});
