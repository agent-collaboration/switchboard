import type { IssuedPersonSession } from '#sign-in-core/response-release/sign-in-response-release';

/** Records the provider's answer; a mismatch throws into the handler's session cleanup. */
export async function completePasskeySignIn(props: {
	readonly response: Response;
	readonly issuedSessions: readonly IssuedPersonSession[];
	readonly recordSignIn: (record: {
		readonly actor: string;
		readonly outcome: 'succeeded' | 'failed';
		readonly method: 'passkey';
	}) => Promise<void>;
}): Promise<void> {
	const issued = props.issuedSessions.length === 1 ? props.issuedSessions[0] : undefined;
	if (props.response.ok && issued !== undefined) {
		await props.recordSignIn({ actor: issued.personId, outcome: 'succeeded', method: 'passkey' });
		return;
	}
	await props.recordSignIn({ actor: 'anonymous', outcome: 'failed', method: 'passkey' });
	if (props.response.ok || props.issuedSessions.length > 0)
		throw new Error('Passkey sign-in answer and issued sessions disagree');
}
