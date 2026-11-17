import type { SignInIdSource } from '@agent-collaboration/sign-in-core';
import { getSessionCookie } from 'better-auth/cookies';

/** External transport facts only, never authentication. A browser keeps its
 * address across requests and sessions; explicit old-cookie requests keep that
 * browser's address too. Nothing rotates an address to escape a quota. */
export function createProofBrowserAddresses(ids: SignInIdSource): {
	readonly useBrowser: (browserKey: string) => void;
	readonly current: () => string;
	readonly transportFor: (browserKey: string) => string;
	readonly forCookie: (cookie: string | undefined, transportToken?: string) => string;
	readonly rememberResponse: (headers: Pick<Headers, 'getSetCookie'>, address: string) => void;
} {
	const browsers = new Map<string, { readonly address: string; readonly transportToken: string }>();
	const transports = new Map<string, string>();
	const sessions = new Map<string, string>();
	function addressFor(browserKey: string): string {
		const existing = browsers.get(browserKey);
		if (existing !== undefined) return existing.address;
		const transportToken = ids.nextId();
		const groups = transportToken.replaceAll('-', '').slice(-16).match(/.{4}/gu);
		if (groups === null || groups.length !== 4)
			throw new Error('Proof browser ID has no IPv6 prefix');
		const address = `${groups.join(':')}:0000:0000:0000:0000`;
		browsers.set(browserKey, { address, transportToken });
		transports.set(transportToken, address);
		return address;
	}
	let current = addressFor('default-browser');
	return {
		useBrowser(browserKey): void {
			current = addressFor(browserKey);
		},
		current: () => current,
		transportFor(browserKey): string {
			addressFor(browserKey);
			const browser = browsers.get(browserKey);
			if (browser === undefined) throw new Error('Explicit proof browser was not created');
			return browser.transportToken;
		},
		forCookie(cookie, transportToken): string {
			if (transportToken !== undefined) {
				const address = transports.get(transportToken);
				if (address === undefined) throw new Error('Unknown proof browser transport');
				return address;
			}
			const signedCookie = getSessionCookie(new Headers({ cookie: cookie ?? '' }));
			return signedCookie === null ? current : (sessions.get(signedCookie) ?? current);
		},
		rememberResponse(headers, address): void {
			const cookie = headers
				.getSetCookie()
				.map((value) => value.split(';')[0])
				.join('; ');
			const signedCookie = getSessionCookie(new Headers({ cookie }));
			if (signedCookie !== null) sessions.set(signedCookie, address);
		},
	};
}
