import { createServer } from 'node:http';

/** Reserves a loopback endpoint, closes it by event, then lets the real fetch
 * observe connection refusal. No timer or hanging verifier is involved. */
export async function closedSiteVerifyEndpoint(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen): void => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('Closed siteverify listener did not acquire an address');
	await new Promise<void>((resolveClose, rejectClose): void => {
		server.close((error?: Error): void => {
			if (error === undefined) resolveClose();
			else rejectClose(error);
		});
	});
	return `http://127.0.0.1:${address.port}/siteverify`;
}
