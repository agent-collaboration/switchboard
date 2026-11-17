/// <reference types="node" />

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
	personIdentityFixtureArtifacts,
	encodePersonIdentityFixture,
} from '#sign-in-test-support/test-fixtures/person-identity-fixtures';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const destination = path.join(root, 'packages/sign-in-core/contract-fixtures/person-identity');
await mkdir(destination, { recursive: true });
await Promise.all(
	Object.entries(personIdentityFixtureArtifacts()).map(([name, value]) =>
		writeFile(path.join(destination, name), encodePersonIdentityFixture(value)),
	),
);
await promisify(execFile)('pnpm', ['exec', 'oxfmt', destination], { cwd: root });
