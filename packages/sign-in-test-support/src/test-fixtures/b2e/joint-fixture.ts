import type { LinkFaultControl } from '#sign-in-test-support/test-fixtures/b2e/link-fault-proxy';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** Central's never-dialled public origin: it only forms `htu` and the two audiences. */
export const jointCentralPublicOrigin = 'https://central.example.invalid';

/**
 * One B2e pairing: accepted sign-in on one host against real central on its matching runtime,
 * joined only by the link fault seam. The journey cases see this and nothing host-specific.
 */
export interface JointFixture {
	/** Which pairing ran, for the receipt. */
	readonly pairing: 'node-sign-in-with-tokio-central' | 'workerd-sign-in-with-workerd-central';
	readonly harness: Harness;
	readonly link: Pick<
		LinkFaultControl,
		'events' | 'holdNext' | 'dropReplyOfNext' | 'captureReplies'
	>;
	readonly serviceId: string;
	/** Central's read-only, one-transaction observation of one organization, unparsed. */
	readonly observe: (organization: string) => Promise<unknown>;
	/**
	 * WS7 (Lead, 13 Nov): central restarts with empty storage, as the new central starts (owner,
	 * 12 Nov). It holds nothing for any organization; sign-in and the link seam are unchanged.
	 * Tokio: a new launcher on a fresh root behind the same socket. workerd: a new bridge with
	 * fresh storage behind the same hop. Either way central's clock is set before its first
	 * request.
	 */
	readonly restartCentralEmpty: () => Promise<void>;
	/** Moves sign-in's controlled clock and central's Fleet clocks to one instant. */
	readonly setJointTime: (milliseconds: number) => Promise<void>;
	readonly close: () => Promise<void>;
}
