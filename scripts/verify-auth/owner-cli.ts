/// <reference types="node" />

// Enter the built owner CLI from the checkout.
import { runOwnerCli } from '#auth-owner-cli';

process.exitCode = await runOwnerCli(process.argv.slice(2));
