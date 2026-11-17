import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';

let controlledMilliseconds = initialSignInTestTime;
const nativeDate = Date;

export function setControlledWorkerTime(milliseconds: number): void {
	if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
		throw new Error('Invalid controlled Worker epoch');
	controlledMilliseconds = milliseconds;
}

export function readControlledWorkerTime(): number {
	return controlledMilliseconds;
}

// This separate test module mocks Date without changing any production bundle.
globalThis.Date = new Proxy(nativeDate, {
	apply(): string {
		return new nativeDate(controlledMilliseconds).toString();
	},
	construct(target: DateConstructor, argumentsList: unknown[]): Date {
		const constructed: unknown = Reflect.construct(
			target,
			argumentsList.length === 0 ? [controlledMilliseconds] : argumentsList,
		);
		if (!(constructed instanceof nativeDate))
			throw new Error('Controlled Date did not construct a Date');
		return constructed;
	},
	get(target: DateConstructor, key: string | symbol, receiver: unknown): unknown {
		if (key === 'now') return (): number => controlledMilliseconds;
		const value: unknown = Reflect.get(target, key, receiver);
		return value;
	},
});
