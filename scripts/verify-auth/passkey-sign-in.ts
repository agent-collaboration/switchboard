/** Proves click-only user-verified passkey sign-in and signed-out refusals on both hosts. Use --help.
 * Input: --commit <local commit>; --flows/--checks override selections (see --help).
 * Run from the repository root: pnpm exec tsx scripts/verify-auth/passkey-sign-in.ts --commit <sha>
 * Requires frozen-install/build tools and existing Chrome; reports both hosts and exits nonzero on failure.
 */
import { verificationMain } from './verification-cli';
process.exitCode = await verificationMain('passkey-sign-in', process.argv.slice(2));
