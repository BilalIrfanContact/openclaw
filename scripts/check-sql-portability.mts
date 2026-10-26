import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { productionFile } from "./database-dialect-inventory.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";

type Violation = { line: number; construct: string };
const sqlStatement = /^[\s(]*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu;

// Preserve parentheses/commas outside quoted SQL and comments. Substitutions use
// a parameter token so separated literal pieces cannot manufacture identifiers.
function maskSql(text: string) {
  return text.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (part) => part.replace(/[^\r\n]/gu, " "),
  );
}

function rawViolations(text: string): string[] {
  const masked = maskSql(text);
  const violations: string[] = [];
  for (const match of masked.matchAll(/\b(?:max|min)\s*\(/giu)) {
    let depth = 1;
    for (let index = match.index + match[0].length; index < masked.length; index++) {
      const character = masked[index];
      if (character === "(") {
        depth++;
      }
      if (character === ")" && --depth === 0) {
        break;
      }
      if (character === "," && depth === 1) {
        violations.push(`multi-argument ${match[0].slice(0, 3).toLowerCase()}`);
        break;
      }
    }
  }
  if (/\blimit\s+-\s*(?:[1-9]\d*|0*\.\d*[1-9]\d*)\b/iu.test(masked)) {
    violations.push("negative LIMIT");
  }
  return violations;
}

function callName(expression: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : undefined;
}

function negativeLiteral(node: ts.Node): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand) &&
    Number(node.operand.text) > 0
  );
}

function negativeLimit(node: ts.Node): boolean {
  if (negativeLiteral(node)) {
    return true;
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return negativeLimit(node.template);
  }
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
    return Number(node.text.trim()) < 0;
  }
  if (ts.isParenthesizedExpression(node)) {
    return negativeLimit(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return negativeLimit(node.whenTrue) || negativeLimit(node.whenFalse);
  }
  if (ts.isArrowFunction(node)) {
    return negativeLimit(node.body);
  }
  if (ts.isReturnStatement(node)) {
    return node.expression ? negativeLimit(node.expression) : false;
  }
  if (ts.isBlock(node)) {
    return node.statements.some(negativeLimit);
  }
  if (ts.isCallExpression(node) && ["lit", "raw"].includes(callName(node.expression) ?? "")) {
    return node.arguments[0] ? negativeLimit(node.arguments[0]) : false;
  }
  return false;
}

function templateText(template: ts.TemplateLiteral): string {
  return ts.isTemplateExpression(template)
    ? template.head.text +
        template.templateSpans
          .map((span) => {
            const value = negativeLimit(span.expression) ? " -1 " : " ? ";
            return value + span.literal.text;
          })
          .join("")
    : template.text;
}

/** Syntax guard, not reachability analysis: exemptions belong at the exact SQLite-only expression. */
export function findSqlPortabilityViolations(source: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  const add = (node: ts.Node, construct: string) => {
    const trivia = source.text.slice(node.getFullStart(), node.getStart(source));
    // No file allowlist or blanket dialect-owner exclusion. A marker documents an
    // engine guard or a physically SQLite-only owner; it cannot excuse a PG bug.
    if (/\/\* pg-sqlite-only: [^\r\n]+ \*\/\s*$/u.test(trivia)) {
      return;
    }
    violations.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      construct,
    });
  };
  const raw = (node: ts.Node, text: string) => {
    for (const construct of rawViolations(text)) {
      add(node, construct);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const [first, second] = node.arguments;
      if (
        (name === "fn" || name === "agg") &&
        first &&
        ts.isStringLiteral(first) &&
        /^(?:max|min)$/iu.test(first.text) &&
        second &&
        ts.isArrayLiteralExpression(second) &&
        second.elements.length >= 2
      ) {
        add(node, `multi-argument ${first.text.toLowerCase()}`);
      }
      if (name === "limit" && first) {
        if (negativeLimit(first)) {
          add(node, "negative LIMIT");
        }
      }
      if (
        (name === "raw" || name === "prepare" || name === "exec") &&
        first &&
        ts.isStringLiteral(first)
      ) {
        raw(first, first.text);
      }
    }
    if (ts.isTaggedTemplateExpression(node) && /sql$/iu.test(callName(node.tag) ?? "")) {
      const template = node.template;
      raw(node, templateText(template));
      // Also visit substitutions: nested SQL/builders are independent expressions.
      if (ts.isTemplateExpression(template)) {
        for (const span of template.templateSpans) {
          visit(span.expression);
        }
      }
      return;
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      sqlStatement.test(ts.isTemplateExpression(node) ? node.head.text : node.text)
    ) {
      raw(node, templateText(node));
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          visit(span.expression);
        }
      }
      return;
    }
    if (
      ts.isStringLiteral(node) &&
      sqlStatement.test(node.text) &&
      !(
        ts.isCallExpression(node.parent) &&
        ["raw", "prepare", "exec"].includes(callName(node.parent.expression) ?? "")
      )
    ) {
      raw(node, node.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return violations;
}

export function main(root = process.cwd()): number {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "src",
      "extensions",
      "packages",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        productionFile(file) && !file.endsWith(".sql") && fs.existsSync(path.join(root, file)),
    );
  const candidates = [...new Set(files)]
    .toSorted()
    .map((fileName) => ({ fileName, text: fs.readFileSync(path.join(root, fileName), "utf8") }))
    .filter(({ text }) =>
      /["'`](?:max|min)["'`]|(?<!\.)\b(?:max|min)\s*\(|\.limit\s*\(|\blimit\s*(?:-|\$\{)/iu.test(
        text,
      ),
    );
  using parser = createNativeTypeScriptParser({ cwd: root });
  const sources = parser.parseSourceFiles(candidates);
  let count = 0;
  for (const source of sources) {
    for (const { line, construct } of findSqlPortabilityViolations(source)) {
      console.error(
        `${path.relative(root, source.fileName)}:${line}: ${construct}; use the database-engine dialect owner.`,
      );
      count++;
    }
  }
  console.log(
    `SQL portability: ${count} violations in ${files.length} production files (${candidates.length} parsed).`,
  );
  return count === 0 ? 0 : 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
