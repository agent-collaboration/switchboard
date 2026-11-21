/** Proves organization choice, switching, People and checked membership reads on both hosts. Use --help.
 * Input: --commit <local commit>; --flows/--checks override selections (see --help).
 * Run from the repository root: pnpm exec tsx scripts/verify-auth/organizations.ts --commit <sha>
 * Requires frozen-install/build tools. Reports both hosts and exits nonzero on failure.
 */
import { verificationMain } from './verification-cli';
process.exitCode = await verificationMain('organizations', process.argv.slice(2));
