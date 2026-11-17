import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();

it('serves the sign-in stylesheet through the production host with panel tokens, component recipes and immutable caching', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const response = await harness.auth('/sign-in');
		expect(response.status).toBe(200);
		const html = await response.text();
		const stylesheetPath = /<link rel="stylesheet" href="([^"]+)"/u.exec(html)?.[1];
		if (stylesheetPath === undefined) throw new Error('The served page has no stylesheet');
		expect(stylesheetPath).toMatch(/^\/assets\/sign-in-[a-f0-9]+\.css$/u);
		const stylesheet = await harness.auth(stylesheetPath);
		expect(stylesheet.status).toBe(200);
		expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(stylesheet.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(stylesheet.headers.get('x-content-type-options')).toBe('nosniff');
		const css = await stylesheet.text();
		// These values are the owner-approved canonical Tool Portal palette, not a generated oracle.
		expect(css).toContain('--palette-neutral-n2:#1c2026');
		expect(css).toContain('--palette-surface-card:#272c34');
		expect(css).toContain('.bg-primary');
		expect(css).toContain('.rounded-md');
		expect(css).not.toMatch(/@import\b|url\(["']?https?:/u);
		const head = await harness.auth(stylesheetPath, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('content-type')).toBe(stylesheet.headers.get('content-type'));
		expect(await head.text()).toBe('');
		const unknown = await harness.auth('/assets/sign-in-unknown.css');
		expect(unknown.status).toBe(404);
		const method = await harness.auth(stylesheetPath, { method: 'POST' });
		expect(method.status).toBe(404);
	} finally {
		await harness.close();
	}
});

/** WS6 R-mount: island pages mount through an inline module that carries the
 * page nonce and calls the bundle's mount, so a page a factor form writes into
 * the same window mounts too (the bundle itself is evaluated once per window). */
it('mounts island pages through a nonce-carrying inline bootstrap that imports the fingerprinted island bundle', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const page = await harness.auth('/owner-ready');
		expect(page.status).toBe(200);
		const nonce = /script-src 'nonce-([a-f0-9]+)'/u.exec(
			page.headers.get('content-security-policy') ?? '',
		)?.[1];
		if (nonce === undefined) throw new Error('The island page policy names no script nonce');
		const html = await page.text();
		expect(html).toContain('data-sign-in-island');
		expect(html).not.toMatch(/<script[^>]*\bsrc="\/assets\/sign-in-pages-/u);
		const bootstraps = [
			...html.matchAll(
				/<script nonce="([a-f0-9]+)" type="module">import \{ mountSignInIslands \} from "(\/assets\/sign-in-pages-[a-f0-9]+\.js)"; mountSignInIslands\(document\);<\/script>/gu,
			),
		];
		expect(bootstraps).toHaveLength(1);
		const [bootstrap] = bootstraps;
		if (bootstrap === undefined) throw new Error('The island page has no bootstrap');
		expect(bootstrap[1]).toBe(nonce);
		const bundlePath = bootstrap[2];
		if (bundlePath === undefined) throw new Error('The bootstrap names no bundle');
		const bundle = await harness.auth(bundlePath);
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(await bundle.text()).toMatch(
			/export\s*\{[^}]*\bas mountSignInIslands\b|export\s*\{[^}]*\bmountSignInIslands\b/u,
		);
	} finally {
		await harness.close();
	}
});
