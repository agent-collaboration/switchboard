import ts from 'typescript';

export interface DiscoveredHandlerRoutes {
	readonly paths: readonly string[];
	readonly prefixes: readonly string[];
}

export function unclassifiedHandlerRoutes(
	discovered: DiscoveredHandlerRoutes,
	classifiedPaths: readonly string[],
): DiscoveredHandlerRoutes {
	const paths = new Set(classifiedPaths);
	return {
		paths: discovered.paths.filter((path) => !paths.has(path)),
		prefixes: discovered.prefixes.filter(
			(prefix) => !classifiedPaths.some((path) => path.startsWith(prefix)),
		),
	};
}

function isPathname(expression: ts.Expression): boolean {
	return (
		(ts.isIdentifier(expression) && expression.text === 'pathname') ||
		(ts.isPropertyAccessExpression(expression) && expression.name.text === 'pathname')
	);
}

function requireLiteral(
	expression: ts.Expression,
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
): string {
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
		return expression.text;
	if (ts.isIdentifier(expression) && checker !== undefined) {
		let symbol = checker.getSymbolAtLocation(expression);
		if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
			symbol = checker.getAliasedSymbol(symbol);
		const declaration = symbol?.valueDeclaration;
		if (
			declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			ts.isVariableDeclarationList(declaration.parent) &&
			(declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
			declaration.initializer !== undefined &&
			(ts.isStringLiteral(declaration.initializer) ||
				ts.isNoSubstitutionTemplateLiteral(declaration.initializer))
		)
			return declaration.initializer.text;
	}
	const position = source.getLineAndCharacterOfPosition(expression.getStart(source));
	throw new Error(`Non-literal pathname route at ${source.fileName}:${position.line + 1}`);
}

/** Discover route decisions, failing closed when their route cannot be read as a literal. */
export function discoverHandlerRoutes(
	sourceText: string,
	fileName: string,
): DiscoveredHandlerRoutes {
	const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
	return discoverRoutesInSource(source);
}

export function discoverRoutesInSource(
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
): DiscoveredHandlerRoutes {
	const fileName = source.fileName;
	const paths = new Set<string>();
	const prefixes = new Set<string>();
	function visit(node: ts.Node): void {
		if (ts.isSwitchStatement(node) && isPathname(node.expression)) {
			for (const clause of node.caseBlock.clauses)
				if (ts.isCaseClause(clause)) paths.add(requireLiteral(clause.expression, source, checker));
		}
		if (
			ts.isBinaryExpression(node) &&
			[node.operatorToken.kind].some((kind) =>
				[
					ts.SyntaxKind.EqualsEqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
					ts.SyntaxKind.EqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsToken,
				].includes(kind),
			)
		) {
			if (isPathname(node.left)) paths.add(requireLiteral(node.right, source, checker));
			if (isPathname(node.right)) paths.add(requireLiteral(node.left, source, checker));
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const { expression, name } = node.expression;
			if (name.text === 'startsWith' && isPathname(expression)) {
				const argument = node.arguments[0];
				if (argument === undefined) throw new Error(`Missing pathname prefix in ${fileName}`);
				prefixes.add(requireLiteral(argument, source, checker));
			}
			if (name.text === 'includes' && node.arguments.some(isPathname)) {
				if (!ts.isArrayLiteralExpression(expression))
					throw new Error(`Non-literal pathname route table in ${fileName}`);
				for (const element of expression.elements) {
					if (!ts.isExpression(element)) throw new Error(`Invalid pathname route in ${fileName}`);
					paths.add(requireLiteral(element, source, checker));
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return { paths: [...paths].toSorted(), prefixes: [...prefixes].toSorted() };
}
