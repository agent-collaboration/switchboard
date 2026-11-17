import type { GoogleCatalogFamilyId } from '@agent-collaboration/oauth-broker-contracts';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { describe, expect, it } from 'vitest';

import { getGoogleGogCommandDescriptors } from './google-gog-command-catalog.js';
import {
	literalGrantModel,
	literalIdentityScopes,
	literalOperations,
	literalPermissionGroups,
	literalSelectionModel,
} from './google-grant-literal-model.js';
import { evaluateGoogleOperationGrant } from './google-operation-grant-policy.js';
import {
	compileGooglePermissionSelection,
	getGooglePermissionGroups,
} from './google-permission-catalog.js';

const propertySettings = {
	testCases: 500,
	derandomize: true,
	database: hegel.Database.disabled,
};
const familyIds: readonly GoogleCatalogFamilyId[] = ['communications', 'documents', 'youtube'];

function drawCompleteSelection(
	testCase: hegel.TestCase,
	knownOperation?: (typeof literalOperations)[number],
): {
	readonly operationId: string;
	readonly familyId: GoogleCatalogFamilyId;
	readonly selectedGroupIds: readonly string[];
	readonly ceiling: readonly string[];
	readonly actualScopes: readonly string[];
} {
	const operation = knownOperation ?? testCase.draw(generators.sampledFrom(literalOperations));
	const selectedGroupIds = operation.requiredGroupChoices.map(
		(choices: readonly string[]): string => testCase.draw(generators.sampledFrom(choices)),
	);
	const familyGroups = literalPermissionGroups.filter(
		(group): boolean => group.familyId === operation.familyId,
	);
	const extras = testCase.draw(
		generators.arrays(generators.sampledFrom(familyGroups), { maxSize: 8 }),
	);
	selectedGroupIds.push(...extras.map((group): string => group.groupId));
	const ceiling = familyGroups.map((group): string => group.groupId);
	const selection = literalSelectionModel({
		familyId: operation.familyId,
		groupIds: selectedGroupIds,
		ceiling,
	});
	if (selection.kind === 'refused')
		throw new Error('Complete literal fixture refused its own selection.');
	return {
		operationId: operation.operationId,
		familyId: operation.familyId,
		selectedGroupIds,
		ceiling,
		actualScopes: [...literalIdentityScopes, ...selection.scopes],
	};
}

describe('P5 Google grants against independent literal catalog rules', () => {
	it('pins every operation and permission group used by the independent model', () => {
		// Arrange / Act / Assert: a catalog change must update this reviewed oracle deliberately.
		expect(
			getGoogleGogCommandDescriptors()
				.map((operation): string => operation.operationId)
				.toSorted(),
		).toEqual(literalOperations.map((operation): string => operation.operationId).toSorted());
		expect(
			getGooglePermissionGroups()
				.map((group) => ({
					groupId: group.groupId,
					familyId: group.familyId,
					serviceId: group.serviceId,
					effect: group.effect,
					scope: group.scopes.join(' '),
				}))
				.toSorted((left, right): number => left.groupId.localeCompare(right.groupId)),
		).toEqual(
			[...literalPermissionGroups].toSorted((left, right): number =>
				left.groupId.localeCompare(right.groupId),
			),
		);
	});

	it('compiles exact literal scope unions and local service effects for valid selections', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const familyId = testCase.draw(generators.sampledFrom(familyIds));
			const availableGroups = literalPermissionGroups.filter(
				(group): boolean => group.familyId === familyId,
			);
			const groupIds = testCase
				.draw(generators.arrays(generators.sampledFrom(availableGroups), { maxSize: 32 }))
				.map((group): string => group.groupId);
			const ceiling = availableGroups.map((group): string => group.groupId);
			const input = { familyId, groupIds, ceiling };
			const expected = literalSelectionModel(input);
			testCase.note(JSON.stringify({ input, expected }));
			if (expected.kind === 'refused')
				throw new Error('Generated same-family selection unexpectedly refused by model.');
			// Act
			const compiled = compileGooglePermissionSelection(input);
			// Assert
			expect(compiled.scopes).toEqual(expected.scopes);
			expect(compiled.effects).toEqual(expected.effects);
		}, propertySettings);
	});

	it('refuses groups above the ceiling and unknown or foreign-family selections and ceilings', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const complete = drawCompleteSelection(testCase);
			const foreign = testCase.draw(
				generators.sampledFrom(
					literalPermissionGroups.filter((group): boolean => group.familyId !== complete.familyId),
				),
			);
			const unknown = `unknown.${testCase.draw(generators.text({ alphabet: 'abc09', minSize: 1, maxSize: 20 }))}`;
			const refusals = [
				{ groupIds: complete.selectedGroupIds, ceiling: [] },
				{ groupIds: [unknown], ceiling: complete.ceiling },
				{ groupIds: [foreign.groupId], ceiling: complete.ceiling },
				{ groupIds: complete.selectedGroupIds, ceiling: [...complete.ceiling, foreign.groupId] },
				{ groupIds: complete.selectedGroupIds, ceiling: [...complete.ceiling, unknown] },
			];
			for (const refusal of refusals) {
				const selectionInput = { familyId: complete.familyId, ...refusal };
				const grantInput = {
					...complete,
					selectedGroupIds: refusal.groupIds,
					ceiling: refusal.ceiling,
				};
				testCase.note(JSON.stringify({ selectionInput, grantInput }));
				// Act / Assert
				expect(literalSelectionModel(selectionInput)).toEqual({ kind: 'refused' });
				expect((): unknown => compileGooglePermissionSelection(selectionInput)).toThrow();
				expect(evaluateGoogleOperationGrant(grantInput)).toEqual({ kind: 'unavailable' });
			}
		}, propertySettings);
	});

	it('admits known operations with every required local effect and exact independently computed scopes', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			for (const operation of literalOperations) {
				// Arrange: each generated case reaches every operation, including rare leaves.
				const complete = drawCompleteSelection(testCase, operation);
				const input = {
					...complete,
					actualScopes: complete.actualScopes.toReversed().concat(complete.actualScopes),
				};
				testCase.note(JSON.stringify(input));
				// Act / Assert: scopes have set equality; order and duplicates do not change authority.
				expect(literalGrantModel(input)).toEqual({ kind: 'admitted' });
				expect(evaluateGoogleOperationGrant(input)).toEqual({ kind: 'admitted' });
			}
		}, propertySettings);
	});

	it('refuses missing, surplus and substituted exact-scope evidence', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const complete = drawCompleteSelection(testCase);
			const exactScopes = [...new Set(complete.actualScopes)];
			const removedIndex = testCase.draw(
				generators.integers({ minValue: 0, maxValue: exactScopes.length - 1 }),
			);
			const missingScopes = exactScopes.filter(
				(_scope: string, index: number): boolean => index !== removedIndex,
			);
			const surplusScope = 'https://www.googleapis.com/auth/unselected.synthetic';
			for (const actualScopes of [
				missingScopes,
				[...exactScopes, surplusScope],
				[...missingScopes, surplusScope],
			]) {
				const input = { ...complete, actualScopes };
				testCase.note(JSON.stringify(input));
				// Act / Assert
				expect(literalGrantModel(input)).toEqual({ kind: 'scope-mismatch' });
				expect(evaluateGoogleOperationGrant(input)).toEqual({ kind: 'scope-mismatch' });
			}
		}, propertySettings);
	});

	it('requires complete service and effect support including helper reads and Forms subtypes', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const operation = testCase.draw(generators.sampledFrom(literalOperations));
			const familyGroups = literalPermissionGroups.filter(
				(group): boolean => group.familyId === operation.familyId,
			);
			const ceiling = familyGroups.map((group): string => group.groupId);
			const selectedGroupIds = testCase
				.draw(generators.arrays(generators.sampledFrom(familyGroups), { maxSize: 16 }))
				.map((group): string => group.groupId);
			const selection = literalSelectionModel({
				familyId: operation.familyId,
				groupIds: selectedGroupIds,
				ceiling,
			});
			if (selection.kind === 'refused')
				throw new Error('Same-family support fixture refused by model.');
			const inputs = [
				{
					operationId: operation.operationId,
					selectedGroupIds,
					ceiling,
					actualScopes: [...literalIdentityScopes, ...selection.scopes],
				},
				{
					operationId: 'gmail.drafts.create',
					selectedGroupIds: ['gmail.write'],
					ceiling: ['gmail.read', 'gmail.write'],
					actualScopes: [...literalIdentityScopes, 'https://www.googleapis.com/auth/gmail.modify'],
				},
				{
					operationId: 'forms.responses.list',
					selectedGroupIds: ['forms.body.read'],
					ceiling: ['forms.body.read', 'forms.responses.read'],
					actualScopes: [
						...literalIdentityScopes,
						'https://www.googleapis.com/auth/forms.body.readonly',
					],
				},
				{
					operationId: 'docs.cat',
					selectedGroupIds: ['drive.all-files.read'],
					ceiling: ['drive.all-files.read', 'docs.all-files.read'],
					actualScopes: [
						...literalIdentityScopes,
						'https://www.googleapis.com/auth/drive.readonly',
					],
				},
			];
			for (const input of inputs) {
				testCase.note(JSON.stringify(input));
				// Act / Assert
				expect(evaluateGoogleOperationGrant(input)).toEqual(literalGrantModel(input));
			}
		}, propertySettings);
	});

	it('refuses unknown operation identities even with an otherwise complete authorization', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const complete = drawCompleteSelection(testCase);
			const suffix = testCase.draw(generators.text({ alphabet: 'abc09', minSize: 1, maxSize: 32 }));
			const input = { ...complete, operationId: `${complete.operationId}.unknown.${suffix}` };
			testCase.note(JSON.stringify(input));
			// Act / Assert
			expect(evaluateGoogleOperationGrant(input)).toEqual({ kind: 'unavailable' });
		}, propertySettings);
	});
});
