/**
 * Reads a structural guard's source and answers one question: does it assert
 * that it found something?
 *
 * A guard that sweeps the tree and compares what it found against an
 * allowlist, or against "none of these may exist", passes on an empty sweep.
 * So every scanner has to say, somewhere, that its sweep was not empty. The
 * shapes that count as saying it are listed on `FLOOR_SHAPES` below; anything
 * else is not a floor.
 *
 * This parses the file with the TypeScript compiler rather than grepping it,
 * so a floor that only appears in a comment, inside a string, under `.not`, or
 * inside an `it.skip` does not count.
 *
 * Its honest limit: it answers per file, not per matcher. A guard with three
 * matchers and a floor on one of them passes here. The floor proves the file
 * read something; it does not prove every rule in the file did.
 */
import ts from "typescript";

export type FloorShape =
  | "walkSourceFiles"
  | "scanSourceMatches"
  | "requireFloor"
  | "toBeGreaterThan"
  | "toBeGreaterThanOrEqual"
  | "not.toHaveLength(0)"
  | "toHaveLength(n>0)"
  | "length.toBe(n>0)"
  | "toEqual([non-empty])";

/** Calls that make a file a directory scanner, and so put it in scope. */
const WALKERS = new Set(["readdirSync", "globSync", "walkSourceFiles"]);

function numericValue(node: ts.Expression | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** `x.not.toBeGreaterThan(…)` — the matcher sits under a `.not`. */
function isNegated(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "not"
  );
}

/** `expect(<anything>.length, …).toBe(…)` — the subject is a length. */
function expectSubjectIsLength(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const expectCall = callee.expression;
  if (
    !ts.isCallExpression(expectCall) ||
    !ts.isIdentifier(expectCall.expression) ||
    expectCall.expression.text !== "expect"
  ) {
    return false;
  }
  const subject = expectCall.arguments[0];
  return (
    subject !== undefined &&
    ts.isPropertyAccessExpression(subject) &&
    subject.name.text === "length"
  );
}

/** Inside `it.skip(…)`, `describe.todo(…)`, `test.skip(…)` and friends. */
function isInSkippedBlock(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      ["skip", "todo"].includes(cur.expression.name.text) &&
      ts.isIdentifier(cur.expression.expression) &&
      ["it", "test", "describe"].includes(cur.expression.expression.text)
    ) {
      return true;
    }
  }
  return false;
}

/** The value of property `key` on an object-literal argument, if any. */
function objectProperty(
  arg: ts.Expression | undefined,
  key: string,
): ts.Expression | "shorthand" | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const prop of arg.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === key) {
      return "shorthand";
    }
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === key
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** A floor value counts unless it is a literal below `min`. */
function floorValueCounts(
  value: ts.Expression | "shorthand" | undefined,
  min: number,
): boolean {
  if (value === undefined) return false;
  if (value === "shorthand") return true;
  const n = numericValue(value);
  return n === null || n >= min;
}

function floorShapeOf(call: ts.CallExpression): FloorShape | null {
  const name = calleeName(call);
  const [first, second, third] = call.arguments;
  switch (name) {
    case "walkSourceFiles":
      return floorValueCounts(objectProperty(second, "floor"), 1)
        ? "walkSourceFiles"
        : null;
    case "scanSourceMatches":
      return floorValueCounts(objectProperty(third, "matchFloor"), 1)
        ? "scanSourceMatches"
        : null;
    case "requireFloor":
      return floorValueCounts(third, 1) ? "requireFloor" : null;
    case "toBeGreaterThan":
      if (isNegated(call)) return null;
      return floorValueCounts(first, 0) ? "toBeGreaterThan" : null;
    case "toBeGreaterThanOrEqual":
      if (isNegated(call)) return null;
      return floorValueCounts(first, 1) ? "toBeGreaterThanOrEqual" : null;
    case "toHaveLength": {
      const n = numericValue(first);
      if (isNegated(call)) return n === 0 ? "not.toHaveLength(0)" : null;
      return n !== null && n >= 1 ? "toHaveLength(n>0)" : null;
    }
    case "toBe":
    case "toEqual":
    case "toStrictEqual": {
      if (isNegated(call)) return null;
      // `expect(found).toEqual(["lib/one.ts"])` — the exact, non-empty set.
      if (
        name !== "toBe" &&
        first !== undefined &&
        ts.isArrayLiteralExpression(first) &&
        first.elements.some((el) => !ts.isSpreadElement(el))
      ) {
        return "toEqual([non-empty])";
      }
      // `expect(found.length).toBe(12)` — an exact non-zero count.
      const n = numericValue(first);
      if (n === null || n < 1) return null;
      return expectSubjectIsLength(call) ? "length.toBe(n>0)" : null;
    }
    default:
      return null;
  }
}

export interface GuardFloorReport {
  /** Every floor-asserting call reachable outside a skipped block. */
  floors: FloorShape[];
  /** True when the file calls a directory walker. */
  walksDirectories: boolean;
}

export function analyseGuardSource(
  fileName: string,
  source: string,
): GuardFloorReport {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const floors: FloorShape[] = [];
  let walksDirectories = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && WALKERS.has(name)) walksDirectories = true;
      const shape = floorShapeOf(node);
      if (shape && !isInSkippedBlock(node)) floors.push(shape);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { floors, walksDirectories };
}
