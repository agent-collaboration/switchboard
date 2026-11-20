/// <reference types="node" />
import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function readRepositoryFile(relativePath: string): Promise<string> {
	return await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Switchboard CI workflow topology', () => {
	it('runs every retained validation command on the main branch', async () => {
		const workflow = await readRepositoryFile('.github/workflows/ci.yml');
		expect(workflow.match(/branches: \[main\]/gu)).toHaveLength(2);
		const validation = workflow.slice(
			workflow.indexOf('  validation:'),
			workflow.indexOf('  e2e-host:'),
		);
		for (const command of [
			'pnpm check',
			'pnpm test:unit',
			'pnpm test:integration',
			'pnpm python:test:host',
		]) {
			expect(validation).toContain(`run: ${command}`);
		}
		expect(validation).toContain('uses: ./.github/actions/setup-agent-vm');
		expect(validation).toContain('uses: ./.github/actions/setup-python-workspace');
		expect(validation).not.toMatch(/continue-on-error|--exclude|--retry/u);
	});

	it('keeps host proofs and their setup after removing VM-only lanes', async () => {
		const workflow = await readRepositoryFile('.github/workflows/ci.yml');
		const host = workflow.slice(workflow.indexOf('  e2e-host:'), workflow.indexOf('  check:'));
		expect(host).toContain('          - host');
		expect(host).not.toMatch(/host-docker|vm-mediation/u);
		for (const action of ['setup-agent-vm', 'setup-system-packages']) {
			expect(host).toContain(`uses: ./.github/actions/${action}`);
		}
		expect(host).not.toContain('uses: ./.github/actions/setup-python-workspace');
		expect(host).toContain('run: pnpm run test:e2e:${{ matrix.lane }}');
		expect(host).not.toMatch(/continue-on-error|--exclude|--retry/u);
	});

	it('requires every retained job to succeed behind one aggregate check', async () => {
		const workflow = await readRepositoryFile('.github/workflows/ci.yml');
		const aggregate = workflow.slice(workflow.indexOf('  check:'));
		expect(aggregate).toContain('if: always()');
		for (const job of ['validation', 'e2e-host']) {
			expect(aggregate).toContain(`      - ${job}`);
		}
		expect(aggregate).toContain('validation=${VALIDATION_RESULT}');
		expect(aggregate).toContain('e2e-host=${E2E_HOST_RESULT}');
		expect(aggregate).toContain('if [[ "${result##*=}" != success ]]');
		expect(aggregate).toContain('exit 1');
		expect(workflow).not.toMatch(/e2e-image-cache:|e2e-vm:|python:test:hermes|test:e2e:inventory/u);
	});

	it('retains no release workflow, privileged permissions or publishing step', async () => {
		// Arrange
		const workflowDirectory = path.join(process.cwd(), '.github/workflows');
		const workflowFiles = await fs.readdir(workflowDirectory);

		// Act / Assert: inspect every retained workflow, including future additions.
		expect(workflowFiles).not.toContain('release.yml');
		expect(workflowFiles).not.toContain('release.yaml');
		const workflows = await Promise.all(
			workflowFiles
				.filter((fileName) => /\.ya?ml$/u.test(fileName))
				.map(async (fileName): Promise<string> =>
					readRepositoryFile(`.github/workflows/${fileName}`),
				),
		);
		expect(workflows.length).toBeGreaterThan(0);
		for (const workflow of workflows) {
			expect(workflow).not.toMatch(/\b(?:id-token|contents):\s*write\b/u);
			expect(workflow).not.toMatch(/\bpublish(?:ing)?\b|(?:uses|run):[^\n]*release/iu);
		}
	});
});
