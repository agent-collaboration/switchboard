/** Proves the checked-in deliberate breaks go red at their named assertion, restore exactly and go green. Use --help.
 * Input: --commit <local commit>; --flows/--checks override selections (see --help).
 * Run from the repository root: pnpm exec tsx scripts/verify-auth/security-checks.ts --commit <sha>
 * Requires frozen-install/build tools and existing Chrome; reports both hosts and exits nonzero on failure.
 */
import { verificationMain } from './verification-cli';
process.exitCode = await verificationMain('security-checks', process.argv.slice(2));
