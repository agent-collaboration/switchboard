/** zod 4 decides when it constructs an object schema whether to use its JIT
 * parser, by probing Function(''). The sign-in pages' CSP (script-src nonce
 * only) blocks that probe and logs a violation on every island page. The
 * island entry imports this module first, so every schema the bundle
 * constructs afterwards parses without JIT. */
import { z } from 'zod';

z.config({ jitless: true });
