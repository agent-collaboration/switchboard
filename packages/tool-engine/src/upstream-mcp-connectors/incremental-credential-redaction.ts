import {
	credentialPatternRules,
	findCredentialTextMatches,
	isCredentialWordCharacter,
	pendingCredentialPatternStart,
	type CredentialPatternRule,
} from '#upstream-mcp-connectors/credential-text-matches';
import type { RedactionOptions } from '#upstream-mcp-connectors/upstream-response-middleware';

// Authorization prefixes permit unlimited whitespace. Beyond this retained-text cap,
// mask the ambiguous prefix conservatively instead of retaining it or exposing it.
// The cap must be at least the longest rule prefix (9 UTF-16 code units, password=).
export const maximumPendingCredentialPatternCharacters = 4096;

export interface CredentialTextRedactor {
	/** Return only text whose redaction cannot change when more input arrives. */
	write(text: string): string;
	/** Flush remaining text once; subsequent calls return an empty string. */
	end(): string;
}

/** A regex searches after its previous global match, or continues a match at the edge. */
type PatternStreamState =
	| { readonly kind: 'searching'; readonly offset: number }
	| { readonly kind: 'value'; readonly offset: number }
	| { readonly kind: 'overflow-whitespace'; readonly offset: number };

interface ExactPrefixState {
	readonly value: string;
	readonly fallback: readonly number[];
	length: number;
}

/** Pending text stays original; coverage survives after its matched prefix was emitted. */
interface OpenRedactorState {
	readonly kind: 'open';
	pending: string;
	covered: boolean[];
	start: number;
	end: number;
	precedingWordCharacter: boolean;
	emittingRedaction: boolean;
	patterns: PatternStreamState[];
	readonly prefixes: readonly ExactPrefixState[];
}

type RedactorState = OpenRedactorState | { readonly kind: 'ended' };

function exactPrefixState(value: string): ExactPrefixState {
	const fallback = Array.from({ length: value.length }, (): number => 0);
	let length = 0;
	for (let index = 1; index < value.length; index += 1) {
		while (length > 0 && value.charAt(index) !== value.charAt(length))
			length = fallback[length - 1] ?? 0;
		if (value.charAt(index) === value.charAt(length)) length += 1;
		fallback[index] = length;
	}
	return { value, fallback, length: 0 };
}

/** Prefix failure links track uncertainty, not a second occurrence/redaction policy. */
function advanceExactPrefixes(prefixes: readonly ExactPrefixState[], text: string): number {
	let longest = 0;
	for (const prefix of prefixes) {
		for (let index = 0; index < text.length; index += 1) {
			const character = text.charAt(index);
			while (prefix.length > 0 && character !== prefix.value.charAt(prefix.length))
				prefix.length = prefix.fallback[prefix.length - 1] ?? 0;
			if (character === prefix.value.charAt(prefix.length)) prefix.length += 1;
			if (prefix.length === prefix.value.length)
				prefix.length = prefix.fallback[prefix.length - 1] ?? 0;
		}
		longest = Math.max(longest, prefix.length);
	}
	return longest;
}

function markCovered(covered: boolean[], start: number, end: number): void {
	for (let index = Math.max(0, start); index < Math.min(end, covered.length); index += 1)
		covered[index] = true;
}

function continuePattern(props: {
	readonly state: PatternStreamState;
	readonly rule: CredentialPatternRule;
	readonly text: string;
	readonly offset: number;
	readonly bufferStart: number;
	readonly covered: boolean[];
}): PatternStreamState {
	if (props.state.kind === 'searching') return props.state;
	let cursor = 0;
	if (props.state.kind === 'overflow-whitespace') {
		while (cursor < props.text.length && /\s/.test(props.text.charAt(cursor))) cursor += 1;
		if (cursor === props.text.length) {
			markCovered(
				props.covered,
				props.offset - props.bufferStart,
				props.offset - props.bufferStart + cursor,
			);
			return { kind: 'overflow-whitespace', offset: props.offset + cursor };
		}
	}
	while (cursor < props.text.length && props.rule.valueCharacter.test(props.text.charAt(cursor)))
		cursor += 1;
	markCovered(
		props.covered,
		props.offset - props.bufferStart,
		props.offset - props.bufferStart + cursor,
	);
	return {
		kind: cursor === props.text.length ? 'value' : 'searching',
		offset: props.offset + cursor,
	};
}

function renderPrefix(props: {
	readonly text: string;
	readonly covered: readonly boolean[];
	readonly end: number;
	readonly emittingRedaction: boolean;
}): { readonly text: string; readonly emittingRedaction: boolean } {
	const fragments: string[] = [];
	let emittingRedaction = props.emittingRedaction;
	let cursor = 0;
	while (cursor < props.end) {
		const start = cursor;
		const hidden = props.covered[cursor] === true;
		while (cursor < props.end && (props.covered[cursor] === true) === hidden) cursor += 1;
		if (hidden) {
			if (!emittingRedaction) fragments.push('[REDACTED]');
		} else fragments.push(props.text.slice(start, cursor));
		emittingRedaction = hidden;
	}
	return { text: fragments.join(''), emittingRedaction };
}

export function createCredentialTextRedactor(
	options: RedactionOptions = {},
): CredentialTextRedactor {
	const exactValues = [...new Set(options.exactValues ?? [])].filter((value) => value.length > 0);
	let state: RedactorState = {
		kind: 'open',
		pending: '',
		covered: [],
		start: 0,
		end: 0,
		precedingWordCharacter: false,
		emittingRedaction: false,
		patterns: credentialPatternRules.map(() => ({ kind: 'searching', offset: 0 })),
		prefixes: exactValues.map(exactPrefixState),
	};
	return {
		write(text: string): string {
			if (state.kind === 'ended') throw new Error('Credential redactor has ended.');
			if (text.length === 0) return '';
			const open = state;
			const combined = open.pending + text;
			const covered = [
				...open.covered,
				...Array.from({ length: text.length }, (): boolean => false),
			];
			const nextEnd = open.end + text.length;
			const patterns = credentialPatternRules.map((rule, ruleIndex): PatternStreamState => {
				const previous = open.patterns[ruleIndex];
				if (previous === undefined) throw new Error('Missing credential pattern state.');
				return continuePattern({
					state: previous,
					rule,
					text,
					offset: open.end,
					bufferStart: open.start,
					covered,
				});
			});
			const matches = findCredentialTextMatches({
				text: combined,
				exactValues,
				includePatterns: true,
				exactMatchBoundary: open.end - open.start,
				patternSearchOffsets: patterns.map((pattern) => Math.max(0, pattern.offset - open.start)),
				precedingWordCharacter: open.precedingWordCharacter,
			});
			for (const span of matches.spans) markCovered(covered, span.start, span.end);
			for (const [ruleIndex] of credentialPatternRules.entries()) {
				const last = matches.patternMatches.findLast((match) => match.ruleIndex === ruleIndex);
				if (last !== undefined)
					patterns[ruleIndex] = {
						kind: last.end === combined.length ? 'value' : 'searching',
						offset: open.start + last.end,
					};
			}
			let stableEnd = combined.length - advanceExactPrefixes(open.prefixes, text);
			for (const [ruleIndex, rule] of credentialPatternRules.entries()) {
				const pattern = patterns[ruleIndex];
				if (pattern === undefined) throw new Error('Missing credential pattern state.');
				if (pattern.kind !== 'searching') continue;
				const pending = pendingCredentialPatternStart({
					text: combined,
					rule,
					minimumStart: Math.max(0, pattern.offset - open.start),
					precedingWordCharacter: open.precedingWordCharacter,
				});
				if (pending === undefined) continue;
				if (combined.length - pending > maximumPendingCredentialPatternCharacters) {
					markCovered(covered, pending, combined.length);
					patterns[ruleIndex] = { kind: 'overflow-whitespace', offset: nextEnd };
				} else stableEnd = Math.min(stableEnd, pending);
			}
			// Never send half a decoded surrogate pair to the byte-owning adapter.
			if (
				stableEnd > 0 &&
				stableEnd < combined.length &&
				/[\uD800-\uDBFF]/.test(combined.charAt(stableEnd - 1)) &&
				/[\uDC00-\uDFFF]/.test(combined.charAt(stableEnd))
			)
				stableEnd -= 1;
			const rendered = renderPrefix({
				text: combined,
				covered,
				end: stableEnd,
				emittingRedaction: open.emittingRedaction,
			});
			state = {
				...open,
				pending: combined.slice(stableEnd),
				covered: covered.slice(stableEnd),
				start: open.start + stableEnd,
				end: nextEnd,
				patterns,
				precedingWordCharacter:
					stableEnd === 0
						? open.precedingWordCharacter
						: isCredentialWordCharacter(combined.charAt(stableEnd - 1)),
				emittingRedaction: rendered.emittingRedaction,
			};
			return rendered.text;
		},
		end(): string {
			if (state.kind === 'ended') return '';
			const open = state;
			state = { kind: 'ended' };
			return renderPrefix({
				text: open.pending,
				covered: open.covered,
				end: open.pending.length,
				emittingRedaction: open.emittingRedaction,
			}).text;
		},
	};
}
