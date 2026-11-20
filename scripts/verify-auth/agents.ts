/** Proves owner agent registration, workspace-bound issuance and crossed refusals on both hosts. Use --help.
 * Input: --commit <local commit>; --flows/--checks override selections (see --help).
 * Run from the repository root: pnpm exec tsx scripts/verify-auth/agents.ts --commit <sha>
 * Requires frozen-install/build tools. Reports both hosts and exits nonzero on failure.
 */
import { verificationMain } from './verification-cli';
process.exitCode = await verificationMain('agents', process.argv.slice(2));
