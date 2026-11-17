/** The host-owned link reaches central without exposing a network address to callers. */
export interface CentralTransport {
	readonly fetch: (request: Request) => Promise<Response>;
}
