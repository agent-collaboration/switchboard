/// <reference types="node" />
/** Aggregate sign-in journey driver.
 * Input: --commit <local commit>; --flows/--checks override selections (see --help).
 * Run from the repository root: pnpm exec tsx scripts/verify-auth/verify-auth.ts --commit <sha>
 * Requires frozen-install/build tools and existing Chrome; reports both hosts and exits nonzero on failure.
 */

import { verificationMain } from './verification-cli';

process.exitCode = await verificationMain('all', process.argv.slice(2));
