import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy, configuredGoogleOperationKey } from './oauth-tool-portal-config.js';
import { toolPortalConfigSchema } from './tool-portal-config.js';

const settings = { testCases: 500, derandomize: true, database: hegel.Database.disabled };

it('intersects authored command paths with the independent catalog and preserves local help', () => {
	hegel.test((tc) => {
		const alias = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const send = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const help = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const version = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const versionWord = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		tc.note(JSON.stringify({ alias, send, help, version, versionWord }));
		const input = createOAuthPolicyCompilerTestInput();
		const commands =
			input.toolPortalConfig.profiles.ask.namespaces.google.backend.operations.gog.commands;
		if (alias) commands.push({ path: ['mail', 'search'], flagRules: [] });
		if (send) commands.push({ path: ['gmail', 'send'], flagRules: [] });
		if (help) commands.push({ path: ['--help'], flagRules: [] });
		if (version) commands.push({ path: ['--version'], flagRules: [] });
		if (versionWord) commands.push({ path: ['version'], flagRules: [] });
		expect(toolPortalConfigSchema.safeParse(input.toolPortalConfig).success).toBe(true);
		const compiled = compileOAuthPolicy(input);
		expect(compileOAuthPolicy(input)).toEqual(compiled);
		const set =
			compiled.commandSetsByConfiguredOperation[
				configuredGoogleOperationKey('ask', 'google', 'gog')
			];
		if (set === undefined) throw new Error('Expected compiled command set');
		const pathsByOperation = Object.fromEntries(
			set.descriptors.map((descriptor) => [descriptor.operationId, descriptor.paths]),
		);
		expect(pathsByOperation).toEqual({
			'gmail.search': alias
				? [
						['gmail', 'search'],
						['mail', 'search'],
					]
				: [['gmail', 'search']],
			...(send ? { 'gmail.send': [['gmail', 'send']] } : {}),
		});
		expect(set.noOAuthPaths).toEqual([
			...(help ? [['--help']] : []),
			...(version ? [['--version']] : []),
			...(versionWord ? [['version']] : []),
		]);
	}, settings);
});

it('separates structural rejection from declared semantic refusals and successful compilation', () => {
	hegel.test((tc) => {
		const scenario = tc.draw(generators.integers({ minValue: 0, maxValue: 4 }));
		tc.note(JSON.stringify({ scenario }));
		const input = createOAuthPolicyCompilerTestInput();
		if (scenario === 0) {
			const invalid = { ...input.toolPortalConfig, schemaVersion: 2 };
			expect(toolPortalConfigSchema.safeParse(invalid).success).toBe(false);
			return;
		}
		if (scenario === 1)
			input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands[0] =
				{ path: ['gmail', 'unclassified'], flagRules: [] };
		if (scenario === 2)
			input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.executionTarget.allowedHosts.push(
				'untrusted.example.test',
			);
		if (scenario === 3)
			input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.mandatoryArgvPrefix.push(
				'--access-token=other',
			);
		expect(toolPortalConfigSchema.safeParse(input.toolPortalConfig).success).toBe(true);
		if (scenario === 4) {
			expect(compileOAuthPolicy(input)).toEqual(compileOAuthPolicy(input));
			return;
		}
		const expected =
			scenario === 1
				? 'an admitted Gog command is not a qualified exact catalog path.'
				: scenario === 2
					? 'Google target hosts must equal the code-owned qualified family hosts.'
					: 'Google calls require the fixed Gog executable without authored argv prefixes.';
		expect(() => compileOAuthPolicy(input)).toThrow(`OAuth/Tool Portal compilation: ${expected}`);
	}, settings);
});

it('keeps the canonical defaults revision when agent record order changes', () => {
	hegel.test((tc) => {
		const reverse = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const input = createOAuthPolicyCompilerTestInput();
		input.toolPortalConfig.profiles.ask.oauthApplications[
			'gmail-app'
		].policyDefaults.services.gmail.read = reverse ? 'allow' : 'ask';
		const first = compileOAuthPolicy(input);
		input.toolPortalConfig.agents = { ember: { profile: 'ask' }, sun: { profile: 'shared' } };
		tc.note(JSON.stringify({ reverse, agents: input.toolPortalConfig.agents }));
		const reordered = compileOAuthPolicy(input);
		expect(reordered.defaultsRevision).toBe(first.defaultsRevision);
		expect(reordered.defaultsByAgentApplication).toEqual(first.defaultsByAgentApplication);
	}, settings);
});
