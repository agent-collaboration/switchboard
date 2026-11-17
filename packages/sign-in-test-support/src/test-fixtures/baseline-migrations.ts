import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/** Copy the real main migration, without executing authored fixture DDL. */
export async function prepareBaselineMigrations(props: {
	readonly currentFolder: string;
	readonly runtimeDirectory: string;
}): Promise<string> {
	const baselineFolder = path.join(props.runtimeDirectory, 'baseline-migrations');
	await mkdir(path.join(baselineFolder, 'meta'), { recursive: true });
	const journal = z
		.object({
			version: z.string(),
			dialect: z.string(),
			entries: z.array(
				z.object({
					idx: z.number(),
					version: z.string(),
					when: z.number(),
					tag: z.string(),
					breakpoints: z.boolean(),
				}),
			),
		})
		.parse(
			JSON.parse(await readFile(path.join(props.currentFolder, 'meta/_journal.json'), 'utf8')),
		);
	const baseline = journal.entries[0];
	if (baseline?.tag !== '0000_outstanding_nextwave')
		throw new Error('Main migration identity changed');
	await copyFile(
		path.join(props.currentFolder, baseline.tag + '.sql'),
		path.join(baselineFolder, baseline.tag + '.sql'),
	);
	await writeFile(
		path.join(baselineFolder, 'meta/_journal.json'),
		JSON.stringify({ ...journal, entries: [baseline] }),
	);
	return baselineFolder;
}
