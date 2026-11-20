import { afterAll, afterEach } from 'vitest';

import { nativeBrowserGroups } from '#sign-in-test-support/test-fixtures/native-browser-groups';

export function registerNativeBrowserTestCleanup(): void {
	afterEach((): Promise<void> => nativeBrowserGroups.closeAll('teardown'));
	afterAll((): Promise<void> => nativeBrowserGroups.closeAll('teardown'));
}
