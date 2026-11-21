import ts from 'typescript';

import type { ExpectedFailure } from './verification-decisions';

export function resolveAssertionLocation(props: {
	readonly file: string;
	readonly source: string;
	readonly marker: string;
	readonly assertion: string;
}): NonNullable<ExpectedFailure['location']> {
	if (props.marker.length === 0 || props.source.split(props.marker).length !== 2)
		throw new Error('Expected assertion source changed');
	if (!props.marker.includes(props.assertion)) throw new Error('Assertion is outside its marker');
	const offset = props.source.indexOf(props.marker) + props.marker.indexOf(props.assertion);
	const sourceFile = ts.createSourceFile(props.file, props.source, ts.ScriptTarget.Latest, true);
	const matchers: ts.PropertyAccessExpression[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'expect' &&
			node.getStart(sourceFile) === offset
		) {
			let cursor: ts.Node = node;
			while (true) {
				const parent = cursor.parent;
				if (parent === undefined) break;
				if (ts.isPropertyAccessExpression(parent) && parent.expression === cursor) {
					cursor = parent;
					continue;
				}
				if (
					ts.isCallExpression(parent) &&
					parent.expression === cursor &&
					ts.isPropertyAccessExpression(parent.expression)
				) {
					matchers.push(parent.expression);
					cursor = parent;
					continue;
				}
				break;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	const matcher = matchers[0];
	if (matchers.length !== 1 || matcher === undefined)
		throw new Error('Assertion matcher is missing or ambiguous');
	const address = sourceFile.getLineAndCharacterOfPosition(matcher.name.getStart(sourceFile));
	return { file: props.file, line: address.line + 1, column: address.character + 1 };
}
