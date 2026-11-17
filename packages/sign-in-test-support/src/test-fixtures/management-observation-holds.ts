import { AgentClientManagement as ProductionAgentClientManagement } from '@agent-collaboration/sign-in-host-cloudflare';

import { recordingD1Database } from '#sign-in-test-support/test-fixtures/recording-d1-database';

/** Each invocation delegates to the frozen production class with its own recording
 * database capability; no management factory is rebuilt in the test bundle. */
export class AgentClientManagement extends ProductionAgentClientManagement {
	private productionBinding(requestId?: string): ProductionAgentClientManagement {
		return new ProductionAgentClientManagement(this.ctx, {
			...this.env,
			DB: recordingD1Database(
				this.env.DB,
				requestId === undefined
					? { kind: 'none' }
					: { kind: 'management', bindings: this.env, requestId },
			),
		});
	}
	override async humanCheckStatus(): ReturnType<
		ProductionAgentClientManagement['humanCheckStatus']
	> {
		return this.productionBinding().humanCheckStatus();
	}
	override async isLiveOwner(
		props: Parameters<ProductionAgentClientManagement['isLiveOwner']>[0],
	): ReturnType<ProductionAgentClientManagement['isLiveOwner']> {
		return this.productionBinding().isLiveOwner(props);
	}
	override async ownsAgentClient(
		props: Parameters<ProductionAgentClientManagement['ownsAgentClient']>[0],
	): ReturnType<ProductionAgentClientManagement['ownsAgentClient']> {
		return this.productionBinding().ownsAgentClient(props);
	}
	override async registerAndLink(
		props: Parameters<ProductionAgentClientManagement['registerAndLink']>[0],
	): ReturnType<ProductionAgentClientManagement['registerAndLink']> {
		return this.productionBinding(props.requestId).registerAndLink(props);
	}
	override async link(
		props: Parameters<ProductionAgentClientManagement['link']>[0],
	): ReturnType<ProductionAgentClientManagement['link']> {
		return this.productionBinding(props.requestId).link(props);
	}
	override async unlink(
		props: Parameters<ProductionAgentClientManagement['unlink']>[0],
	): ReturnType<ProductionAgentClientManagement['unlink']> {
		return this.productionBinding(props.requestId).unlink(props);
	}
	override async disable(
		props: Parameters<ProductionAgentClientManagement['disable']>[0],
	): ReturnType<ProductionAgentClientManagement['disable']> {
		return this.productionBinding(props.requestId).disable(props);
	}
}
