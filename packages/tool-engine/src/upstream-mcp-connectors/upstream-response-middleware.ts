import type { JsonValue } from '@agent-collaboration/tool-access/contracts';

const credentialPatterns = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bBasic\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(api[_-]?key|token|password|secret)=([^&\s]+)/gi,
];

export interface RedactionOptions {
	readonly exactValues?: readonly string[];
}

export function isCredentialConfigKey(key: string): boolean {
	const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
	return (
		normalizedKey === 'auth' ||
		normalizedKey === 'authorization' ||
		normalizedKey === 'apikey' ||
		normalizedKey.endsWith('apikey') ||
		normalizedKey.endsWith('token') ||
		normalizedKey.endsWith('password') ||
		normalizedKey.endsWith('secret')
	);
}

interface RedactionSpan {
	readonly start: number;
	end: number;
}

function redactCredentialSpans(
	text: string,
	exactValues: readonly string[],
	patterns: readonly RegExp[],
): string {
	const occurrences: RedactionSpan[] = [];
	for (const value of new Set(exactValues)) {
		if (value.length === 0) continue;
		let start = text.indexOf(value);
		let current: RedactionSpan | undefined;
		while (start !== -1) {
			const end = start + value.length;
			// One value's matches are ordered; retain one span per contiguous run.
			if (current !== undefined && start <= current.end) current.end = end;
			else {
				current = { start, end };
				occurrences.push(current);
			}
			// Advance one code unit so repeated occurrences can overlap themselves.
			start = text.indexOf(value, start + 1);
		}
	}
	// Find every match in the original text: replacing one match first can split another.
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			occurrences.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	occurrences.sort((left, right) => left.start - right.start || right.end - left.end);
	const merged: RedactionSpan[] = [];
	for (const occurrence of occurrences) {
		const previous = merged.at(-1);
		if (previous !== undefined && occurrence.start <= previous.end)
			previous.end = Math.max(previous.end, occurrence.end);
		else merged.push({ ...occurrence });
	}
	const fragments: string[] = [];
	let cursor = 0;
	for (const span of merged) {
		fragments.push(text.slice(cursor, span.start), '[REDACTED]');
		cursor = span.end;
	}
	fragments.push(text.slice(cursor));
	return fragments.join('');
}

export function redactExactCredentialText(text: string, options: RedactionOptions = {}): string {
	return redactCredentialSpans(text, options.exactValues ?? [], []);
}

export function redactCredentialText(text: string, options: RedactionOptions = {}): string {
	return redactCredentialSpans(text, options.exactValues ?? [], credentialPatterns);
}

function redactJsonValue(value: unknown, options: RedactionOptions, keyHint?: string): unknown {
	if (typeof value === 'string') {
		return keyHint && isCredentialConfigKey(keyHint)
			? '[REDACTED]'
			: redactCredentialText(value, options);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => redactJsonValue(entry, options));
	}

	if (typeof value !== 'object' || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [
			key,
			redactJsonValue(childValue, options, key),
		]),
	);
}

function redactExactJsonValue(value: unknown, options: RedactionOptions): unknown {
	if (typeof value === 'string') {
		return redactExactCredentialText(value, options);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => redactExactJsonValue(entry, options));
	}

	if (typeof value !== 'object' || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [
			key,
			redactExactJsonValue(childValue, options),
		]),
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}

	if (typeof value !== 'object') {
		return false;
	}

	return Object.values(value).every(isJsonValue);
}

export function redactUpstreamResponse(response: unknown, options: RedactionOptions = {}): unknown {
	return redactJsonValue(response, options);
}

export function redactUpstreamCatalogValue(
	response: unknown,
	options: RedactionOptions = {},
): unknown {
	return redactExactJsonValue(response, options);
}

function copyRedactedErrorField(props: {
	readonly source: Error;
	readonly target: Error;
	readonly fieldName: string;
	readonly options: RedactionOptions;
}): void {
	const descriptor = Object.getOwnPropertyDescriptor(props.source, props.fieldName);
	if (!descriptor || !('value' in descriptor)) {
		return;
	}
	Object.defineProperty(props.target, props.fieldName, {
		...descriptor,
		value: redactJsonValue(descriptor.value, props.options),
	});
}

export function redactThrownError(error: unknown, options: RedactionOptions = {}): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof Error)) {
		return new Error(redactCredentialText(message, options));
	}

	const rawCause = 'cause' in error ? error.cause : undefined;
	const redactedCause =
		rawCause === undefined || rawCause === error
			? undefined
			: rawCause instanceof Error
				? redactThrownError(rawCause, options)
				: redactJsonValue(rawCause, options);
	const redactedError =
		redactedCause === undefined
			? new Error(redactCredentialText(message, options))
			: new Error(redactCredentialText(message, options), { cause: redactedCause });
	redactedError.name = error.name;
	if (error.stack) {
		redactedError.stack = redactCredentialText(error.stack, options);
	}
	copyRedactedErrorField({ fieldName: 'code', options, source: error, target: redactedError });
	copyRedactedErrorField({ fieldName: 'data', options, source: error, target: redactedError });
	return redactedError;
}

export function toRedactedJsonValue(value: unknown, options: RedactionOptions = {}): JsonValue {
	const redacted = redactJsonValue(value, options);
	if (isJsonValue(redacted)) {
		return redacted;
	}

	return null;
}
