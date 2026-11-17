import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { GatewayRuntimeFrameDecoder } from './gateway-runtime-protocol.js';

it('M5 decoder rejects bodies above the independently measured UTF-8 limit', () => {
	hegel.test(
		(tc: hegel.TestCase): void => {
			const payload = tc.draw(generators.text({ alphabet: 'abé資料', minSize: 1, maxSize: 100 }));
			const message = { jsonrpc: '2.0', id: 1, result: payload };
			const body = JSON.stringify(message);
			const bodyLength = Buffer.byteLength(body, 'utf8');
			const frame = Buffer.from(`Content-Length: ${bodyLength}\r\n\r\n${body}`, 'utf8');
			tc.note(JSON.stringify({ payload, bodyLength }));
			expect(new GatewayRuntimeFrameDecoder({ maxContentBytes: bodyLength }).push(frame)).toEqual([
				message,
			]);
			expect((): unknown =>
				new GatewayRuntimeFrameDecoder({ maxContentBytes: bodyLength - 1 }).push(frame),
			).toThrow(expect.objectContaining({ code: 'CONTENT_TOO_LARGE' }));
		},
		{ testCases: 500, derandomize: true, database: hegel.Database.disabled },
	);
});
