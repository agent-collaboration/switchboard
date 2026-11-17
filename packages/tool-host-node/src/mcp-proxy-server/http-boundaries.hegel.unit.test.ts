import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	authenticateNodeHostRequest,
	compileNodeHostCredentialSet,
	parseNodeHostBearerToken,
} from '#node-host/mcp-proxy-server/bearer-credentials';
import {
	compileNodeHostHttpRequestPolicy,
	nodeHostHttpRequestIsAllowed,
} from '#node-host/mcp-proxy-server/http-request-policy';

const settings = { testCases: 500, derandomize: true, database: hegel.Database.disabled };

function requestWithHeaders(props: {
	readonly host?: string;
	readonly origin?: string;
	readonly target?: string;
}): IncomingMessage {
	const request = new IncomingMessage(new Socket());
	request.url = props.target;
	if (props.host !== undefined) request.headers.host = props.host;
	if (props.origin !== undefined) request.headers.origin = props.origin;
	return request;
}

it('matches bearer token bytes and parses only the expected authorization form', () => {
	hegel.test((tc) => {
		const suffix = tc.draw(generators.integers({ minValue: 0, maxValue: 999999 }));
		const token = `token-${suffix}-é`;
		const state = compileNodeHostCredentialSet({
			audience: 'tool-portal:mcp',
			serviceGeneration: 'generation-one',
			credentials: [
				{
					bearerToken: token,
					credentialVersion: 1,
					principal: {
						agentId: 'agent-one',
						profileAssignmentRevision: 'revision-one',
						toolPortalProfileId: 'profile-one',
					},
				},
			],
		});
		const header = `Bearer ${token}`;
		tc.note(`header=${JSON.stringify(header)}`);
		expect(
			authenticateNodeHostRequest(parseNodeHostBearerToken(header), state)?.principal.agentId,
		).toBe('agent-one');
		for (const changed of [`${token}x`, token.toUpperCase(), token.normalize('NFD')]) {
			expect(authenticateNodeHostRequest(changed, state)).toBeNull();
		}
		for (const invalid of [
			undefined,
			`bearer ${token}`,
			`Bearer ${token} extra`,
			`Bearer ${token} `,
			` Bearer ${token}`,
			'Bearer',
		]) {
			expect(parseNodeHostBearerToken(invalid)).toBeNull();
		}
	}, settings);
});

it('checks Host by canonical hostname and Origin by canonical scheme, host and port', () => {
	hegel.test((tc) => {
		const label = `host${tc.draw(generators.integers({ minValue: 0, maxValue: 999999 }))}`;
		const port = tc.draw(generators.integers({ minValue: 1024, maxValue: 65535 }));
		const hostname = `${label}.example`;
		const origin = `http://${hostname}:${port}`;
		const policy = compileNodeHostHttpRequestPolicy({
			allowedHosts: [hostname],
			allowedOrigins: [origin],
		});
		tc.note(`host=${hostname} port=${port}`);
		for (const host of [hostname.toUpperCase(), `${hostname}:${port}`]) {
			expect(
				nodeHostHttpRequestIsAllowed(
					requestWithHeaders({
						host,
						origin: `HTTP://${hostname.toUpperCase()}:${port}/`,
						target: '/',
					}),
					policy,
				),
			).toBe(true);
		}
		expect(
			nodeHostHttpRequestIsAllowed(requestWithHeaders({ host: hostname, target: '/' }), policy),
		).toBe(true);
		for (const foreignOrigin of [
			`http://${hostname}.foreign:${port}`,
			`https://${hostname}:${port}`,
			`http://${hostname}:${port === 65535 ? 65534 : port + 1}`,
			`${origin}/path`,
		]) {
			expect(
				nodeHostHttpRequestIsAllowed(
					requestWithHeaders({ host: hostname, origin: foreignOrigin, target: '/' }),
					policy,
				),
			).toBe(false);
		}
		for (const foreignHost of [`${hostname}.foreign`, `foreign.${hostname}`, `${hostname}/path`]) {
			expect(
				nodeHostHttpRequestIsAllowed(
					requestWithHeaders({ host: foreignHost, origin, target: '/' }),
					policy,
				),
			).toBe(false);
		}
	}, settings);
});

it('accepts only origin-form request targets at the policy boundary', () => {
	hegel.test((tc) => {
		const segment = `path${tc.draw(generators.integers({ minValue: 0, maxValue: 999999 }))}`;
		const policy = compileNodeHostHttpRequestPolicy({
			allowedHosts: ['localhost'],
			allowedOrigins: [],
		});
		tc.note(`segment=${segment}`);
		for (const target of [`/${segment}`, `/${segment}?query=1`, '/']) {
			expect(
				nodeHostHttpRequestIsAllowed(requestWithHeaders({ host: 'localhost', target }), policy),
			).toBe(true);
		}
		for (const target of [undefined, segment, `//${segment}`, `http://localhost/${segment}`, '*']) {
			expect(
				nodeHostHttpRequestIsAllowed(requestWithHeaders({ host: 'localhost', target }), policy),
			).toBe(false);
		}
	}, settings);
});
