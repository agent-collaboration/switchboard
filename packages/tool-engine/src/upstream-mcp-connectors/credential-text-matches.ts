/** The batch and incremental redactors share these rules and occurrence matching. */
export interface CredentialPatternRule {
	readonly expression: RegExp;
	readonly prefixes: readonly string[];
	readonly kind: 'authorization' | 'assignment';
	readonly valueCharacter: RegExp;
}

const authorizationCharacters = '[A-Za-z0-9._~+/=-]';
const assignmentCharacters = '[^&\\s]';
const assignmentNames = ['apikey', 'api_key', 'api-key', 'token', 'password', 'secret'];

export const credentialPatternRules: readonly CredentialPatternRule[] = [
	...['Bearer', 'Basic'].map((prefix): CredentialPatternRule => ({
		expression: new RegExp(`\\b${prefix}\\s+${authorizationCharacters}+`, 'gi'),
		prefixes: [prefix],
		kind: 'authorization',
		valueCharacter: new RegExp(`^${authorizationCharacters}$`),
	})),
	{
		expression: new RegExp(`\\b(?:${assignmentNames.join('|')})=${assignmentCharacters}+`, 'gi'),
		prefixes: assignmentNames.map((name) => `${name}=`),
		kind: 'assignment',
		valueCharacter: new RegExp(`^${assignmentCharacters}$`),
	},
];

export interface RedactionSpan {
	readonly start: number;
	end: number;
}

export interface CredentialPatternMatch extends RedactionSpan {
	readonly ruleIndex: number;
}

export function isCredentialWordCharacter(text: string): boolean {
	return /^[A-Za-z0-9_]$/.test(text);
}

export function findCredentialTextMatches(props: {
	readonly text: string;
	readonly exactValues: readonly string[];
	readonly includePatterns: boolean;
	readonly patternSearchOffsets?: readonly number[];
	readonly precedingWordCharacter?: boolean;
	/** Earlier matches already have retained coverage in an incremental caller. */
	readonly exactMatchBoundary?: number;
}): {
	readonly spans: readonly RedactionSpan[];
	readonly patternMatches: readonly CredentialPatternMatch[];
} {
	const occurrences: RedactionSpan[] = [];
	for (const value of new Set(props.exactValues)) {
		if (value.length === 0) continue;
		let start = props.text.indexOf(
			value,
			Math.max(0, (props.exactMatchBoundary ?? 0) - value.length + 1),
		);
		let current: RedactionSpan | undefined;
		while (start !== -1) {
			const end = start + value.length;
			if (current !== undefined && start <= current.end) current.end = end;
			else {
				current = { start, end };
				occurrences.push(current);
			}
			start = props.text.indexOf(value, start + 1);
		}
	}
	const patternMatches: CredentialPatternMatch[] = [];
	if (props.includePatterns) {
		// The context character affects only regex word boundaries, never exact matching.
		const contextualText = `${props.precedingWordCharacter === true ? 'a' : ' '}${props.text}`;
		for (const [ruleIndex, rule] of credentialPatternRules.entries()) {
			const expression = new RegExp(rule.expression);
			expression.lastIndex = Math.max(0, props.patternSearchOffsets?.[ruleIndex] ?? 0) + 1;
			for (
				let match = expression.exec(contextualText);
				match !== null;
				match = expression.exec(contextualText)
			) {
				const span = { start: match.index - 1, end: match.index - 1 + match[0].length };
				occurrences.push(span);
				patternMatches.push({ ...span, ruleIndex });
			}
		}
	}
	occurrences.sort((left, right) => left.start - right.start || right.end - left.end);
	const spans: RedactionSpan[] = [];
	for (const occurrence of occurrences) {
		const previous = spans.at(-1);
		if (previous !== undefined && occurrence.start <= previous.end)
			previous.end = Math.max(previous.end, occurrence.end);
		else spans.push({ ...occurrence });
	}
	return { spans, patternMatches };
}

/** Find an unfinished introduction for this same rule, after its prior global match. */
export function pendingCredentialPatternStart(props: {
	readonly text: string;
	readonly rule: CredentialPatternRule;
	readonly minimumStart: number;
	readonly precedingWordCharacter: boolean;
}): number | undefined {
	let earliest: number | undefined;
	for (const prefix of props.rule.prefixes) {
		for (let length = 1; length <= prefix.length; length += 1) {
			const start = props.text.length - length;
			if (start < props.minimumStart || start < 0) continue;
			const precedingWord =
				start === 0
					? props.precedingWordCharacter
					: isCredentialWordCharacter(props.text.slice(start - 1, start));
			if (
				!precedingWord &&
				props.text.slice(start).toLowerCase() === prefix.slice(0, length).toLowerCase()
			)
				earliest = Math.min(earliest ?? start, start);
		}
		if (props.rule.kind === 'authorization') {
			const contextualText = `${props.precedingWordCharacter ? 'a' : ' '}${props.text}`;
			const match = new RegExp(`\\b${prefix}\\s*$`, 'i').exec(contextualText);
			if (match !== null && match.index - 1 >= props.minimumStart)
				earliest = Math.min(earliest ?? match.index - 1, match.index - 1);
		}
	}
	return earliest;
}
