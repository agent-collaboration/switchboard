import { signInWorkerConfiguration } from '@agent-collaboration/sign-in-host-cloudflare/configuration';

import {
	createStorageCaseContext,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageCaseErrorMessage } from '#sign-in-test-support/storage-cases/storage-case-errors';
import {
	executeStorageCommand,
	storageCommandSchema,
} from '#sign-in-test-support/storage-cases/storage-commands';
import { recordingD1Database } from '#sign-in-test-support/test-fixtures/recording-d1-database';

const noInjectedFault: StorageCaseContext['readFault'] = () => null;

export default {
	async fetch(request: Request, bindings: AuthWorkerEnv): Promise<Response> {
		try {
			const command = storageCommandSchema.parse(await request.json());
			let readFault: StorageCaseContext['readFault'] = noInjectedFault;
			let startReadInterleaving: StorageCaseContext['startReadInterleaving'] = () => null;
			const host = signInWorkerConfiguration({
				...bindings,
				DB: recordingD1Database(
					bindings.DB,
					{ kind: 'none' },
					() => readFault(),
					async (query) => {
						await startReadInterleaving(query);
					},
				),
			});
			const context = createStorageCaseContext({
				openDatabase: host.openDatabase,
				runAtomically: host.platform.runAtomically,
				faultInjection: 'driver',
			});
			readFault = context.readFault;
			startReadInterleaving = context.startReadInterleaving;
			return Response.json({
				kind: 'result',
				value: await executeStorageCommand(context, command),
			});
		} catch (error) {
			return Response.json(
				{ kind: 'case-error', message: storageCaseErrorMessage(error) },
				{ status: 500 },
			);
		}
	},
};
