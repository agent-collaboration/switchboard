import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	account,
	fixture,
	googleFixture,
	namespace,
	state,
} from '#tool-access/authorization/access-assessor-test-fixture';
import { mcpPortalCallPolicyDecision } from '#tool-access/authorization/mcp-approval-policy';
import {
	createPortalAgentIdentity,
	resolvePortalAccessPolicy,
} from '#tool-access/authorization/portal-access-policy';
import { resolvedMcpPortalProfileSchema } from '#tool-access/contracts/mcp-approval-profile';

const settings = {
	testCases: 500,
	seed: 20261117,
	derandomize: true,
	database: hegel.Database.disabled,
};
const identity = createPortalAgentIdentity({
	agentId: 'agent',
	agentScopeId: 'scope',
	source: 'tool-portal-service',
});

it('resolves namespace defaults and overrides, and preserves genuine set extension', () => {
	hegel.test((tc) => {
		const defaultAllow = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const globalMode = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const agentMode = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		tc.note(JSON.stringify({ defaultAllow, globalMode, agentMode }));
		const config = {
			defaultPolicy: defaultAllow ? 'allow-all' : 'deny-all',
			...(globalMode === 0
				? {}
				: { enabledNamespaces: globalMode === 1 ? [] : ['alpha', 'missing'] }),
			enabledNamespacesByAgent:
				agentMode === 0 ? {} : { agent: agentMode === 1 ? [] : ['beta', 'missing'] },
			hiddenToolsByAgent: {},
		} as const;
		const expected =
			agentMode === 1
				? []
				: agentMode === 2
					? ['beta']
					: globalMode === 1
						? []
						: globalMode === 2
							? ['alpha']
							: defaultAllow
								? ['alpha', 'beta']
								: [];
		expect(
			resolvePortalAccessPolicy({ config, identity, upstreamNamespaces: ['beta', 'alpha'] })
				.allowedNamespaces,
		).toEqual(expected);
		const mask = tc.draw(generators.integers({ minValue: 0, maxValue: 7 }));
		const extra = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const names = ['alpha', 'beta', 'gamma'];
		const selected = names.filter((_, index) => (mask & (1 << index)) !== 0);
		const extended = names.filter((_, index) => (mask & (1 << index)) !== 0 || index === extra);
		tc.note(JSON.stringify({ selected, extended }));
		const upstreamNamespaces = ['alpha', 'beta', 'gamma'];
		const smaller = resolvePortalAccessPolicy({
			config: { ...config, enabledNamespacesByAgent: { agent: selected } },
			identity,
			upstreamNamespaces,
		});
		const larger = resolvePortalAccessPolicy({
			config: { ...config, enabledNamespacesByAgent: { agent: extended } },
			identity,
			upstreamNamespaces,
		});
		expect(smaller.allowedNamespaces).toEqual(selected);
		expect(larger.allowedNamespaces).toEqual(extended);
		expect(smaller.allowedNamespaces.every((name) => larger.allowedNamespaces.includes(name))).toBe(
			true,
		);
	}, settings);
});

it('uses the independent MCP annotation and selector decision table', () => {
	hegel.test((tc) => {
		const trusted = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const readOnly = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const destructive = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const alwaysAsk = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const selector = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		tc.note(JSON.stringify({ trusted, readOnly, destructive, alwaysAsk, selector }));
		const profile = resolvedMcpPortalProfileSchema.parse({
			enabledNamespaces: ['tools'],
			enabledToolsByNamespace: {},
			hiddenToolsByNamespace: {},
			logging: { enabled: false },
			promptContext: { enabled: false, maxNamespaces: 1 },
			cache: { catalogTtlMs: 1 },
			approval: {
				annotationPolicy: alwaysAsk ? 'always-require-approval' : 'destructive-requires-approval',
				trustedAnnotationNamespaces: trusted ? ['tools'] : [],
				callPoliciesByNamespace: {
					tools: {
						withoutApproval: {
							allow: selector === 0 ? [] : '*',
							deny: selector === 2 ? ['run'] : [],
						},
						requiresApproval: { allow: [], deny: [] },
					},
				},
			},
		});
		const expected =
			selector === 1 || (!alwaysAsk && trusted && readOnly && !destructive)
				? 'allow_without_approval'
				: alwaysAsk
					? 'requires_approval'
					: 'blocked';
		expect(
			mcpPortalCallPolicyDecision(profile, {
				namespace: 'tools',
				toolName: 'run',
				annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
			}).kind,
		).toBe(expected);
	}, settings);
});

it('applies assessor prerequisites before call policy and upstream availability', () => {
	hegel.test((tc) => {
		const revoked = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const workspaceAllowed = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const eligible = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const denied = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const unavailable = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		tc.note(JSON.stringify({ revoked, workspaceAllowed, eligible, denied, unavailable }));
		const input = fixture();
		if (input.facts.workspace.kind !== 'configured')
			throw new Error('Expected configured workspace');
		input.facts.workspace.registration.status = revoked ? 'revoked' : 'active';
		input.facts.workspace.allowance.allowed = workspaceAllowed;
		input.facts.surface.eligible = eligible ? ['mcp'] : [];
		namespace(input).tools.deny = denied ? ['run'] : [];
		input.facts.upstream.status = unavailable ? 'unavailable' : 'available';
		const expected = revoked
			? { kind: 'not-usable', firstUnmet: 'registration-revoked' }
			: !workspaceAllowed
				? { kind: 'not-usable', firstUnmet: 'not-allowed-in-workspace' }
				: !eligible
					? { kind: 'not-usable', firstUnmet: 'not-given-to-agent' }
					: denied
						? { kind: 'blocked-by-policy', rule: { source: 'profile-selector', ruleId: 'run' } }
						: unavailable
							? { kind: 'not-usable', firstUnmet: 'service-unavailable' }
							: { kind: 'usable' };
		expect(state(input)).toEqual(expected);
	}, settings);
});

it('applies account prerequisites before an otherwise usable Google call', () => {
	hegel.test((tc) => {
		const granted = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const applying = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const availability = tc.draw(generators.integers({ minValue: 0, maxValue: 3 }));
		tc.note(JSON.stringify({ granted, applying, availability }));
		const input = googleFixture();
		const fact = account(input);
		fact.granted = granted;
		fact.policySnapshotState = applying ? 'applying' : 'active';
		if (availability === 1) fact.availability = { kind: 'denied' };
		if (availability === 2) fact.availability = { kind: 'consent-required' };
		if (availability === 3) fact.availability = { kind: 'unavailable' };
		const expected = !granted
			? { kind: 'not-usable', firstUnmet: 'account-not-granted' }
			: applying
				? { kind: 'not-usable', firstUnmet: 'account-policy-paused' }
				: availability === 1
					? { kind: 'blocked-by-policy', rule: { source: 'account-policy', ruleId: 'run' } }
					: availability === 2
						? { kind: 'not-usable', firstUnmet: 'consent-missing-or-expired' }
						: availability === 3
							? { kind: 'not-usable', firstUnmet: 'service-unavailable' }
							: { kind: 'usable' };
		expect(state(input)).toEqual(expected);
	}, settings);
});

it('handles an unknown tool using selector visibility and call-policy mode', () => {
	hegel.test((tc) => {
		const visibility = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const callMode = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const annotationMode = tc.draw(generators.integers({ minValue: 0, maxValue: 1 }));
		tc.note(JSON.stringify({ visibility, callMode, annotationMode }));
		const input = fixture();
		input.capability.tool = 'unknown';
		const policy = namespace(input);
		policy.tools =
			visibility === 0
				? { allow: ['run'], deny: [] }
				: { allow: '*', deny: visibility === 1 ? ['unknown'] : [] };
		policy.calls = {
			kind: 'selectors',
			withoutApproval: { allow: callMode === 0 ? '*' : [], deny: [] },
			requiresApproval: { allow: callMode === 1 ? '*' : [], deny: [] },
		};
		const expected =
			visibility === 0
				? { kind: 'not-usable', firstUnmet: 'not-given-to-agent' }
				: visibility === 1
					? { kind: 'blocked-by-policy', rule: { source: 'profile-selector', ruleId: 'unknown' } }
					: callMode === 0
						? { kind: 'usable' }
						: callMode === 1
							? { kind: 'approval-each-call' }
							: {
									kind: 'blocked-by-policy',
									rule: { source: 'mcp-approval-policy', ruleId: 'unknown' },
								};
		expect(state(input)).toEqual(expected);
		const profile = resolvedMcpPortalProfileSchema.parse({
			enabledNamespaces: ['tools'],
			enabledToolsByNamespace: {},
			hiddenToolsByNamespace: {},
			logging: { enabled: false },
			promptContext: { enabled: false, maxNamespaces: 1 },
			cache: { catalogTtlMs: 1 },
			approval: {
				annotationPolicy:
					annotationMode === 1 ? 'always-require-approval' : 'destructive-requires-approval',
			},
		});
		expect(
			mcpPortalCallPolicyDecision(profile, { namespace: 'tools', toolName: 'unknown' }).kind,
		).toBe(annotationMode === 1 ? 'requires_approval' : 'blocked');
	}, settings);
});
