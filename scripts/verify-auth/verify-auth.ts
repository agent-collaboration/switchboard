import { verificationMain } from './verification-cli';

const args = process.argv.slice(2);
const [journey] = args;
if (journey === 'organization' || journey === 'revision-fence') {
	const { runAuthVerification } =
		await import('../../packages/sign-in-test-support/src/test-fixtures/auth-verification-cli');
	process.exitCode = await runAuthVerification(args);
} else {
	process.exitCode = await verificationMain('all', args);
}
