#!/usr/bin/env node
'use strict';

// Split one big CommonJS file into feature folders, each with a named owner,
// and prove nothing changed. The method is atris/skills/feature-folders/SKILL.md.
//
//   node lib/split-file.js analyze --plan <plan.json>    show what would move where, write nothing
//   node lib/split-file.js split   --plan <plan.json>    do every move, write folders, READMEs, order file
//   node lib/split-file.js rebuild --plan <plan.json> [--out <file>]   put the original back together
//   node lib/split-file.js verify  --plan <plan.json> [--original <file>] [--json]   run the proofs
//
// The plan is JSON. Paths are relative to the repo root (the git top of the plan file):
//   {
//     "source": "commands/task.js",            the big file
//     "outDir": "commands/task",               where feature folders go
//     "teamDir": "atris/team",                 owners live here as <owner>/MEMBER.md
//     "keep": ["run"],                         functions that must stay in the big file
//     "unplaced": "stay",                      functions no feature reaches: "stay" or "core"
//     "core": { "summary": "..." },            shared code, used by several features
//     "features": [ { "name": "review", "owner": "validator", "summary": "...",
//                     "names": ["exactName"], "spans": [["firstFn", "lastFn"]], "patterns": ["^taskReview"] } ]
//   }
// A function goes, in this order, to the feature that names it, whose span (every function from
// firstFn through lastFn in file order) holds it, or whose pattern matches it. Anything left goes
// to the one feature whose functions reach it, to core when several do, else per "unplaced".
//
// Only top-level function declarations move. A function stays when it can run while the
// file is loading, assigns or reads a top-level name that is reassigned, uses `module` or
// `exports`, or builds a relative require path at run time. Each moved file borrows the
// names it needs through bindMain(deps), which the big file calls as its last step.
// The parser is the TypeScript compiler API. It is not a dependency of this package:
// install it once outside the repo with `npm i --prefix ~/.cache/atris-split typescript`
// or point ATRIS_SPLIT_TYPESCRIPT at an installed typescript folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TOOL = 'lib/split-file.js';
const WIRING_GLOBALS = new Set(['require', 'module', 'exports', '__dirname', '__filename']);
const UNRESOLVED_CODES = new Set([2304, 2552, 2580, 2581, 2582, 2591, 2592, 2593, 2662, 2663]);

function loadTypescript(root) {
  const tries = [];
  if (process.env.ATRIS_SPLIT_TYPESCRIPT) tries.push(process.env.ATRIS_SPLIT_TYPESCRIPT);
  if (root) tries.push(path.join(root, 'node_modules', 'typescript'));
  tries.push('typescript');
  tries.push(path.join(os.homedir(), '.cache', 'atris-split', 'node_modules', 'typescript'));
  for (const id of tries) {
    try { return require(id); } catch {}
  }
  const err = new Error('split-file needs the TypeScript parser. Install it outside the repo: npm i --prefix ~/.cache/atris-split typescript');
  err.code = 'NO_TYPESCRIPT';
  throw err;
}

// ---------- parsing ----------

function parse(ts, text, name = 'file.js') {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

// The standard library files parse once per process; they are the slow part of every program.
const libCache = new Map();
function program(ts, files, options) {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => {
    if (files[name] !== undefined) return ts.createSourceFile(name, files[name], lang, true, ts.ScriptKind.JS);
    if (!libCache.has(name)) libCache.set(name, original(name, lang));
    return libCache.get(name);
  };
  host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
  host.readFile = (name) => (files[name] !== undefined ? files[name] : ts.sys.readFile(name));
  host.writeFile = () => {};
  return ts.createProgram(Object.keys(files), options, host);
}

function baseOptions(ts) {
  return { allowJs: true, noResolve: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [] };
}

// One name per top-level piece: the function name, or the first line of the statement.
function statementKeys(ts, sourceFile, statements) {
  const seen = new Map();
  return statements.map((statement) => {
    let key;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) key = `fn:${statement.name.text}`;
    else key = `line:${statement.getText(sourceFile).split('\n')[0].trim().slice(0, 100)}`;
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count ? `${key}#${count}` : key;
  });
}

// A piece runs from the end of the previous piece to the end of its statement, plus a comment
// left on its last line. Joined in order, the pieces and the tail are the file, byte for byte.
function pieceRanges(text, statements) {
  let previousEnd = 0;
  return statements.map((statement) => {
    let end = statement.getEnd();
    const comment = /^[ \t]*\/\/[^\n]*/.exec(text.slice(end, end + 400));
    if (comment) end += comment[0].length;
    const start = Math.max(statement.getFullStart(), previousEnd);
    previousEnd = end;
    return [start, end];
  });
}

function bindingNames(ts, name, out = []) {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(ts, element.name, out);
  return out;
}

function isFunctionLike(ts, node) {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

// The identifier is a name of something else (a.b, {b: 1}, label), not a reference.
function isNamePosition(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return true;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return false;
}

function isAssignmentOperator(ts, kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function relativeRequireLiteral(ts, node) {
  if (!ts.isCallExpression(node) || !node.arguments.length) return null;
  const callee = node.expression;
  const isRequire = (ts.isIdentifier(callee) && callee.text === 'require')
    || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve')
    || callee.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire) return null;
  const arg = node.arguments[0];
  if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text.startsWith('.')) return { arg, dynamic: false };
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
    let relative = false;
    const look = (n) => { if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && n.text.startsWith('.')) relative = true; n.forEachChild(look); };
    look(arg);
    if (relative) return { arg, dynamic: true };
  }
  return null;
}

// The table that drives every later step: for each top-level statement, what it declares,
// which top-level names it reads, which it assigns, and what pins it in place.
function analyzeSource(ts, text) {
  const fileName = '/split/source.js';
  const prog = program(ts, { [fileName]: text }, { ...baseOptions(ts), noLib: true });
  const checker = prog.getTypeChecker();
  const sf = prog.getSourceFile(fileName);
  const statements = [...sf.statements];
  const keys = statementKeys(ts, sf, statements);
  const ranges = pieceRanges(text, statements);
  const declNode = new Map();
  const topNames = new Map();
  statements.forEach((statement, index) => {
    const add = (nameNode, decl) => {
      declNode.set(decl, nameNode.text);
      if (!topNames.has(nameNode.text)) topNames.set(nameNode.text, []);
      topNames.get(nameNode.text).push(index);
    };
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) add(statement.name, statement);
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) add(decl.name, decl);
        else for (const id of bindingNames(ts, decl.name)) add(id, id.parent);
      }
    }
  });
  // True when the name is declared in this file (a local), not the CommonJS module, exports or __dirname.
  const declaredHere = (id) => {
    const symbol = checker.getSymbolAtLocation(id);
    return Boolean(symbol && symbol.declarations && symbol.declarations.some((d) => d.getSourceFile() === sf
      && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d) || ts.isFunctionDeclaration(d)
        || ts.isFunctionExpression(d) || ts.isClassDeclaration(d))));
  };
  const topOf = (id) => {
    const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
    if (!symbol || !symbol.declarations) return null;
    for (const decl of symbol.declarations) if (declNode.has(decl)) return declNode.get(decl);
    return null;
  };
  const reassigned = new Set();
  const info = statements.map((statement, index) => {
    const isFunction = ts.isFunctionDeclaration(statement) && Boolean(statement.name) && Boolean(statement.body);
    const own = isFunction ? statement.name.text : null;
    const item = {
      index, key: keys[index], isFunction, name: own,
      lines: text.slice(ranges[index][0], ranges[index][1]).replace(/^\s*\n/, '').split('\n').length,
      refs: new Set(), loadCalls: new Set(), loadValues: new Set(), assigns: new Set(),
      usesModule: false, usesDirname: false, usesFilename: false, dynamicRequire: false, requires: [], dirnames: [],
    };
    const visit = (node, deferred) => {
      if (node !== statement && isFunctionLike(ts, node)) deferred = true;
      if (ts.isIdentifier(node) && !isNamePosition(ts, node)) {
        const name = topOf(node);
        const declaring = node.parent && (node.parent.name === node) && (declNode.has(node.parent) || node.parent === statement);
        if (name && !declaring) {
          if (name !== own) item.refs.add(name);
          if (!isFunction && !deferred) {
            const parent = node.parent;
            const value = (ts.isPropertyAssignment(parent) && parent.initializer === node)
              || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
              || ts.isArrayLiteralExpression(parent);
            (value ? item.loadValues : item.loadCalls).add(name);
          }
        }
        if (!name && ['module', 'exports', '__dirname', '__filename'].includes(node.text) && !declaredHere(node)) {
          if (node.text === 'module' || node.text === 'exports') item.usesModule = true;
          if (node.text === '__dirname') { item.usesDirname = true; item.dirnames.push(node); }
          if (node.text === '__filename') { item.usesFilename = true; item.dirnames.push(node); }
        }
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(ts, node.operatorToken.kind)) {
        const targets = [];
        const collect = (n) => { if (ts.isIdentifier(n)) targets.push(n); else if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n) || ts.isSpreadElement(n) || ts.isParenthesizedExpression(n)) n.forEachChild(collect); };
        collect(ts.isPropertyAssignment(node.left) ? node.left.initializer : node.left);
        for (const id of targets) { const name = topOf(id); if (name) { item.assigns.add(name); reassigned.add(name); } }
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        const name = topOf(node.operand);
        if (name) { item.assigns.add(name); reassigned.add(name); }
      }
      const req = relativeRequireLiteral(ts, node);
      if (req) { if (req.dynamic) item.dynamicRequire = true; else item.requires.push(req.arg); }
      node.forEachChild((child) => visit(child, deferred));
    };
    visit(statement, false);
    return item;
  });
  return { ts, text, sf, statements, keys, ranges, info, topNames, reassigned };
}

// ---------- paths ----------

function relSpec(fromDir, toAbs, trailingSlash) {
  let rel = path.relative(fromDir, toAbs).split(path.sep).join('/');
  if (!rel) rel = '.';
  if (!rel.startsWith('.')) rel = `./${rel}`;
  if (trailingSlash && !rel.endsWith('/')) rel += '/';
  return rel;
}
// Rewrite a relative require written in fromDir so it works from toDir. When one folder sits
// under the other, only a '../' prefix is added or removed, so the spelling comes back exactly.
function moveSpec(spec, fromDir, toDir) {
  const down = path.relative(fromDir, toDir);
  const up = path.relative(toDir, fromDir);
  if (down && !down.startsWith('..') && !path.isAbsolute(down)) {
    const prefix = '../'.repeat(down.split(path.sep).length);
    if (spec === '.') return prefix.slice(0, -1);
    if (spec.startsWith('./')) return prefix + spec.slice(2);
    if (spec.startsWith('../')) return prefix + spec;
  }
  if (up && !up.startsWith('..') && !path.isAbsolute(up)) {
    const prefix = '../'.repeat(up.split(path.sep).length);
    if (spec === prefix.slice(0, -1)) return '.';
    if (spec.startsWith(prefix)) {
      const rest = spec.slice(prefix.length);
      return rest.startsWith('../') ? rest : `./${rest}`;
    }
  }
  return relSpec(toDir, path.resolve(fromDir, spec), spec.endsWith('/'));
}

// ---------- plan ----------

function gitTop(dir) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const root = plan.root ? path.resolve(path.dirname(abs), plan.root) : (gitTop(path.dirname(abs)) || process.cwd());
  if (!plan.source || !plan.outDir || !Array.isArray(plan.features)) throw new Error('plan needs source, outDir and features');
  const features = plan.features.map((f) => ({ ...f, names: f.names || [], patterns: (f.patterns || []).map((p) => new RegExp(p)) }));
  for (const f of features) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f.name)) throw new Error(`feature name must be lower-case words with dashes: ${f.name}`);
  }
  const coreSummary = (plan.core && plan.core.summary) || 'Shared helpers that several features use.';
  const core = features.find((f) => f.name === 'core');
  if (core) Object.assign(core, { owner: null, summary: core.summary || coreSummary });
  else features.push({ name: 'core', owner: null, summary: coreSummary, names: [], patterns: [] });
  const source = path.join(root, plan.source);
  const outDir = path.join(root, plan.outDir);
  return {
    ...plan, root, planPath: abs, features, source, outDir,
    order: path.join(root, plan.order || path.join(plan.outDir, 'split-order.json')),
    teamDir: plan.teamDir ? path.join(root, plan.teamDir) : null,
    keep: new Set(plan.keep || []),
    unplaced: plan.unplaced || 'stay',
    date: plan.date || new Date().toISOString().slice(0, 10),
  };
}

function featureFile(plan, feature) {
  return path.join(plan.outDir, feature, `${feature}.js`);
}

// ---------- decide what moves where ----------

function decide(plan, analysis) {
  const { info, topNames, reassigned } = analysis;
  const fnByName = new Map(info.filter((i) => i.isFunction).map((i) => [i.name, i]));
  const pinned = new Map();
  const pin = (name, why) => { if (fnByName.has(name) && !pinned.has(name)) pinned.set(name, why); };
  const srcDir = path.dirname(plan.source);
  for (const item of info) {
    if (!item.isFunction) continue;
    const name = item.name;
    if (plan.keep.has(name)) pin(name, 'kept by the plan');
    if ((topNames.get(name) || []).length > 1) pin(name, 'its name is declared twice');
    if (item.assigns.size) pin(name, `assigns top-level ${[...item.assigns].join(', ')}`);
    const stale = [...item.refs].filter((r) => reassigned.has(r));
    if (stale.length) pin(name, `reads reassigned top-level ${stale.join(', ')}`);
    if (item.usesModule) pin(name, 'uses module or exports');
    if (item.dynamicRequire) pin(name, 'builds a relative require path at run time');
    for (const spec of item.requires) {
      const outDir = path.dirname(featureFile(plan, 'x'));
      if (moveSpec(moveSpec(spec.text, srcDir, outDir), outDir, srcDir) !== spec.text) pin(name, `require path ${spec.text} would not rebuild exactly`);
    }
  }
  for (const reserved of ['bindMain', 'MAIN_DIR', 'MAIN_FILE']) {
    if (topNames.has(reserved) || analysis.text.includes(reserved)) throw new Error(`the source already uses ${reserved}; the split needs that name`);
  }
  // Anything load-time code calls, and everything that reaches, runs before bindMain and must stay.
  const queue = [];
  for (const item of info) {
    if (item.isFunction) continue;
    for (const name of item.loadCalls) if (fnByName.has(name)) { pin(name, 'runs while the file loads'); queue.push(name); }
  }
  const seenLoad = new Set(queue);
  while (queue.length) {
    const name = queue.shift();
    for (const ref of fnByName.get(name).refs) {
      if (!fnByName.has(ref) || seenLoad.has(ref)) continue;
      seenLoad.add(ref);
      pin(ref, `runs while the file loads, through ${name}`);
      queue.push(ref);
    }
  }
  const assigned = new Map();
  const why = new Map();
  for (const item of info) {
    if (!item.isFunction || pinned.has(item.name)) continue;
    for (const f of plan.features) {
      if (f.names.includes(item.name)) { assigned.set(item.name, f.name); why.set(item.name, 'named in the plan'); break; }
    }
  }
  // A span is every function from one named function through another, in file order.
  const fnOrder = info.filter((i) => i.isFunction).map((i) => i.name);
  for (const f of plan.features) {
    for (const [from, to] of f.spans || []) {
      const a = fnOrder.indexOf(from);
      const b = fnOrder.indexOf(to);
      if (a === -1 || b === -1 || b < a) throw new Error(`${f.name}: span ${from}..${to} is not two functions in file order`);
      for (const name of fnOrder.slice(a, b + 1)) {
        if (pinned.has(name) || assigned.has(name)) continue;
        assigned.set(name, f.name);
        why.set(name, `in the span ${from}..${to}`);
      }
    }
  }
  for (const item of info) {
    if (!item.isFunction || pinned.has(item.name) || assigned.has(item.name)) continue;
    for (const f of plan.features) {
      if (f.patterns.some((re) => re.test(item.name))) { assigned.set(item.name, f.name); why.set(item.name, 'name matches the plan'); break; }
    }
  }
  for (const f of plan.features) for (const n of f.names) if (pinned.has(n)) why.set(n, `plan asked for ${f.name}, but it stays: ${pinned.get(n)}`);
  // Unplaced functions go to the one feature whose seeds reach them; several features means core.
  const reach = new Map();
  for (const f of plan.features) {
    const seen = new Set();
    const todo = [...assigned].filter(([, feat]) => feat === f.name).map(([n]) => n);
    while (todo.length) {
      const name = todo.pop();
      for (const ref of fnByName.get(name).refs) {
        if (!fnByName.has(ref) || seen.has(ref) || assigned.has(ref) || pinned.has(ref)) continue;
        seen.add(ref);
        todo.push(ref);
        if (!reach.has(ref)) reach.set(ref, new Set());
        reach.get(ref).add(f.name);
      }
    }
  }
  for (const item of info) {
    if (!item.isFunction || pinned.has(item.name) || assigned.has(item.name)) continue;
    const by = reach.get(item.name);
    if (by && by.size === 1) { assigned.set(item.name, [...by][0]); why.set(item.name, 'only this feature uses it'); }
    else if (by && by.size > 1) { assigned.set(item.name, 'core'); why.set(item.name, `shared by ${[...by].join(', ')}`); }
    else if (plan.unplaced === 'core') { assigned.set(item.name, 'core'); why.set(item.name, 'no feature reaches it'); }
  }
  return { pinned, assigned, why, fnByName };
}

// ---------- write ----------

function wrapList(names, indent, width = 100) {
  const lines = [];
  let line = '';
  for (const name of names) {
    const piece = line ? `, ${name}` : name;
    if (line && indent.length + line.length + piece.length + 1 > width) { lines.push(`${indent}${line},`); line = name; }
    else line += piece;
  }
  if (line) lines.push(`${indent}${line},`);
  return lines.join('\n');
}

function wrapComment(sentence, width = 100) {
  const lines = [];
  let line = '//';
  for (const word of sentence.split(/\s+/)) {
    if (line.length + word.length + 1 > width && line !== '//') { lines.push(line); line = '//'; }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

function checkOwners(plan) {
  if (!plan.teamDir) return;
  for (const f of plan.features) {
    if (f.owner && f.name !== 'core' && !fs.existsSync(path.join(plan.teamDir, f.owner, 'MEMBER.md'))) {
      throw new Error(`${f.name}: owner ${f.owner} has no MEMBER.md in ${path.relative(plan.root, plan.teamDir)}; leave the owner out to mark it unassigned`);
    }
  }
}

function buildSplit(plan, analysis, decision) {
  const { ts, text, statements, ranges, info } = analysis;
  const srcDir = path.dirname(plan.source);
  const topLevel = [...analysis.topNames.keys()];
  const features = plan.features.map((f) => ({ ...f, items: info.filter((i) => i.isFunction && decision.assigned.get(i.name) === f.name) }))
    .filter((f) => f.items.length);
  const movedNames = new Set(features.flatMap((f) => f.items.map((i) => i.name)));
  const featureOf = new Map(features.flatMap((f) => f.items.map((i) => [i.name, f.name])));
  const files = {};
  for (const f of features) {
    const file = featureFile(plan, f.name);
    const dir = path.dirname(file);
    const own = new Set(f.items.map((i) => i.name));
    const borrowed = topLevel.filter((n) => !own.has(n) && f.items.some((i) => i.refs.has(n)));
    const needsDir = f.items.some((i) => i.usesDirname || i.usesFilename);
    const needsFile = f.items.some((i) => i.usesFilename);
    const bodies = f.items.map((item) => {
      const [start, end] = ranges[item.index];
      const edits = [];
      for (const id of item.dirnames) edits.push([id.getStart(), id.getEnd(), id.text === '__dirname' ? 'MAIN_DIR' : 'MAIN_FILE']);
      for (const lit of item.requires) {
        const quote = text[lit.getStart()];
        edits.push([lit.getStart(), lit.getEnd(), `${quote}${moveSpec(lit.text, srcDir, dir)}${quote}`]);
      }
      edits.sort((a, b) => b[0] - a[0]);
      let piece = text.slice(start, end);
      for (const [s, e, rep] of edits) piece = piece.slice(0, s - start) + rep + piece.slice(e - start);
      return piece;
    });
    const sourceRel = path.relative(plan.root, plan.source).split(path.sep).join('/');
    const fileRel = path.relative(plan.root, file).split(path.sep).join('/');
    const header = [];
    if (/^\s*(\/\/[^\n]*\n\s*)*['"]use strict['"]/.test(text)) header.push("'use strict';", '');
    header.push(...wrapComment(`${fileRel}: ${f.summary || f.name}`));
    header.push(...wrapComment(`Owner: ${f.name === 'core' ? 'shared, see README.md' : (f.owner || 'unassigned')}. Moved out of ${sourceRel} on ${plan.date} by ${TOOL}; read README.md first.`));
    header.push('');
    if (needsDir) header.push(`const MAIN_DIR = require('path').resolve(__dirname, '${relSpec(dir, srcDir).replace(/^\.\//, '')}');`);
    if (needsFile) header.push(`const MAIN_FILE = require('path').join(MAIN_DIR, '${path.basename(plan.source)}');`);
    if (needsDir) header.push('');
    if (borrowed.length) {
      header.push(`// Names borrowed from ${sourceRel} and other feature folders, set by bindMain().`);
      header.push(`let ${wrapList(borrowed, '  ').trim().replace(/,$/, '')};`);
      header.push('function bindMain(deps) {');
      header.push('  ({');
      header.push(wrapList(borrowed, '    '));
      header.push('  } = deps);');
      header.push('}');
    } else {
      header.push('function bindMain() {}');
    }
    const footer = `\n\nmodule.exports = {\n${wrapList(['bindMain', ...f.items.map((i) => i.name)], '  ')}\n};\n`;
    files[file] = header.join('\n') + bodies.join('') + footer;
    f.borrowed = borrowed;
    f.uses = [...new Set(borrowed.map((n) => featureOf.get(n)).filter(Boolean))].filter((n) => n !== f.name);
    f.usesMain = borrowed.some((n) => !featureOf.has(n));
    f.file = file;
    f.lineCount = files[file].split('\n').length - 1;
  }
  // The slimmed big file: kept pieces in order, one require per folder where the first moved
  // piece sat, and every bindMain call as the very last step.
  let insertAt = info.findIndex((i) => movedNames.has(i.name));
  const firstValueRef = info.findIndex((i) => !i.isFunction && [...i.loadValues].some((n) => movedNames.has(n)));
  if (firstValueRef !== -1 && firstValueRef < insertAt) insertAt = firstValueRef;
  const requireSpec = (f) => relSpec(srcDir, f.file);
  const wiringTop = [`\n\n// Moved into feature folders on ${plan.date} by ${TOOL}. Each folder's README names its owner: ${relSpec(srcDir, path.join(plan.outDir, 'README.md'))}`];
  for (const f of features) wiringTop.push(`const {\n${wrapList(f.items.map((i) => i.name), '  ')}\n} = require('${requireSpec(f)}');`);
  const wiringEnd = ['\n\n// Hand each feature folder the names it borrows. Keep this the last step of loading.'];
  for (const f of features) {
    wiringEnd.push(f.borrowed.length ? `require('${requireSpec(f)}').bindMain({\n${wrapList(f.borrowed, '  ')}\n});` : `require('${requireSpec(f)}').bindMain({});`);
  }
  let main = '';
  statements.forEach((statement, index) => {
    if (index === insertAt) main += wiringTop.join('\n');
    if (!movedNames.has(info[index].name)) main += text.slice(ranges[index][0], ranges[index][1]);
  });
  const lastEnd = ranges.length ? ranges[ranges.length - 1][1] : 0;
  main += wiringEnd.join('\n') + text.slice(lastEnd);
  files[plan.source] = main;
  return { files, features, movedNames };
}

// ---------- rebuild ----------

function asWrittenInSource(ts, pieceText, srcDir, dir) {
  const sf = parse(ts, pieceText);
  const edits = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isNamePosition(ts, node) && (node.text === 'MAIN_DIR' || node.text === 'MAIN_FILE')) {
      edits.push([node.getStart(sf), node.getEnd(), node.text === 'MAIN_DIR' ? '__dirname' : '__filename']);
    }
    const req = relativeRequireLiteral(ts, node);
    if (req && !req.dynamic) {
      const quote = pieceText[req.arg.getStart(sf)];
      edits.push([req.arg.getStart(sf), req.arg.getEnd(), `${quote}${moveSpec(req.arg.text, dir, srcDir)}${quote}`]);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  edits.sort((a, b) => b[0] - a[0]);
  let out = pieceText;
  for (const [s, e, rep] of edits) out = out.slice(0, s) + rep + out.slice(e);
  return out;
}

function isWiring(ts, sf, statement, srcDir, outDir) {
  const intoOut = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('.')
    && path.resolve(srcDir, node.arguments[0].text).startsWith(outDir + path.sep);
  if (ts.isVariableStatement(statement)) {
    const decls = statement.declarationList.declarations;
    return decls.length === 1 && decls[0].initializer && intoOut(decls[0].initializer);
  }
  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
    const callee = statement.expression.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'bindMain' && intoOut(callee.expression);
  }
  return false;
}

function featureFilesOnDisk(plan) {
  if (!fs.existsSync(plan.outDir)) return [];
  return fs.readdirSync(plan.outDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => featureFile(plan, d.name)).filter((f) => fs.existsSync(f)).sort();
}

function featurePieces(ts, file, text) {
  const sf = parse(ts, text, file);
  const pieces = sf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text !== 'bindMain');
  const ranges = pieceRanges(text, sf.statements).filter((_, i) => pieces.includes(sf.statements[i]));
  return pieces.map((p, i) => ({ key: `fn:${p.name.text}`, name: p.name.text, text: text.slice(ranges[i][0], ranges[i][1]) }));
}

function rebuild(plan, ts, texts = {}) {
  const read = (file) => (texts[file] !== undefined ? texts[file] : fs.readFileSync(file, 'utf8'));
  const order = JSON.parse(read(plan.order));
  const srcDir = path.dirname(plan.source);
  const mainText = read(plan.source);
  const mainSf = parse(ts, mainText, plan.source);
  const all = [...mainSf.statements];
  const allRanges = pieceRanges(mainText, all);
  const keptIdx = all.map((s, i) => i).filter((i) => !isWiring(ts, mainSf, all[i], srcDir, plan.outDir));
  const keptKeys = statementKeys(ts, mainSf, keptIdx.map((i) => all[i]));
  const pieces = new Map();
  keptIdx.forEach((i, k) => pieces.set(keptKeys[k], mainText.slice(allRanges[i][0], allRanges[i][1])));
  const files = Object.keys(texts).filter((f) => f.startsWith(plan.outDir + path.sep) && f.endsWith('.js'));
  const featureList = files.length ? files.sort() : featureFilesOnDisk(plan);
  for (const file of featureList) {
    for (const piece of featurePieces(ts, file, read(file))) {
      if (pieces.has(piece.key)) throw new Error(`${piece.name} is defined twice (in ${file} and elsewhere)`);
      pieces.set(piece.key, asWrittenInSource(ts, piece.text, srcDir, path.dirname(file)));
    }
  }
  const used = new Set();
  const out = [];
  const missing = [];
  for (const key of order.keys) {
    if (!pieces.has(key)) { missing.push(key); continue; }
    out.push(pieces.get(key));
    used.add(key);
  }
  const extra = [...pieces.keys()].filter((k) => !used.has(k));
  for (const key of extra) out.push(pieces.get(key));
  const lastEnd = allRanges.length ? allRanges[allRanges.length - 1][1] : 0;
  out.push(mainText.slice(lastEnd));
  return { text: out.join(''), missing, extra };
}

// ---------- proofs ----------

function unresolvedNames(ts, files, wiringOf) {
  const prog = program(ts, files, { ...baseOptions(ts), checkJs: true, lib: ['lib.es2022.d.ts'] });
  const counts = new Map();
  for (const name of Object.keys(files)) {
    const sf = prog.getSourceFile(name);
    const wiring = wiringOf ? wiringOf(name, sf) : () => false;
    for (const d of prog.getSemanticDiagnostics(sf)) {
      if (!UNRESOLVED_CODES.has(d.code) || d.start === undefined) continue;
      const word = sf.text.slice(d.start, d.start + d.length);
      if (WIRING_GLOBALS.has(word) && wiring(d.start)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return counts;
}

function lineDiffCount(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), a);
    fs.writeFileSync(path.join(dir, 'b'), b);
    const res = spawnSync('diff', [path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
    const changed = (res.stdout || '').split('\n').filter((l) => /^[<>]/.test(l));
    return { lines: changed.length, blankOnly: changed.every((l) => /^[<>]\s*$/.test(l)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function frozenPath(sha) {
  return path.join(os.homedir(), '.cache', 'atris-split', 'frozen', `${sha.slice(0, 16)}.js`);
}

function findOriginal(plan, order, explicit) {
  if (explicit) return fs.readFileSync(explicit, 'utf8');
  if (fs.existsSync(frozenPath(order.sha256))) return fs.readFileSync(frozenPath(order.sha256), 'utf8');
  if (order.base) {
    const res = spawnSync('git', ['show', `${order.base}:${order.source}`], { cwd: plan.root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (res.status === 0) return res.stdout;
  }
  throw new Error('cannot find the original file: pass --original <file>');
}

function verify(plan, ts, opts = {}) {
  const results = [];
  const order = JSON.parse(fs.readFileSync(plan.order, 'utf8'));
  const original = findOriginal(plan, order, opts.original);
  const sha = crypto.createHash('sha256').update(original).digest('hex');
  results.push({ check: 'original', ok: sha === order.sha256, detail: sha === order.sha256 ? `sha256 ${sha.slice(0, 12)} matches the order file` : `sha256 ${sha.slice(0, 12)} is not the split original ${order.sha256.slice(0, 12)}` });
  const built = rebuild(plan, ts);
  const diff = lineDiffCount(original, built.text);
  results.push({
    check: 'rebuild', ok: diff.blankOnly && !built.missing.length && !built.extra.length,
    detail: `${diff.lines} differing lines${diff.lines ? (diff.blankOnly ? ' (blank lines only)' : '') : ''}; ${built.missing.length} missing pieces; ${built.extra.length} pieces not in the order file`,
  });
  const featureList = featureFilesOnDisk(plan);
  const files = [plan.source, ...featureList];
  const syntaxFails = files.filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
  results.push({ check: 'syntax', ok: !syntaxFails.length, detail: `node --check passed on ${files.length - syntaxFails.length} of ${files.length} files${syntaxFails.length ? `; failed: ${syntaxFails.join(', ')}` : ''}` });
  // Loads: each folder file and the big file load, and each exports what the big file takes from it.
  const mainText = fs.readFileSync(plan.source, 'utf8');
  const mainSf = parse(ts, mainText, plan.source);
  const srcDir = path.dirname(plan.source);
  const wants = {};
  const passes = {};
  for (const s of mainSf.statements) {
    if (!isWiring(ts, mainSf, s, srcDir, plan.outDir)) continue;
    if (ts.isVariableStatement(s)) {
      const d = s.declarationList.declarations[0];
      const file = path.resolve(srcDir, d.initializer.arguments[0].text);
      wants[file] = ts.isObjectBindingPattern(d.name) ? d.name.elements.map((e) => (e.propertyName || e.name).text) : [];
    } else {
      const call = s.expression;
      const file = path.resolve(srcDir, call.expression.expression.arguments[0].text);
      const arg = call.arguments[0];
      passes[file] = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.map((p) => p.name.text) : [];
    }
  }
  const exportsOf = (sf) => {
    const last = sf.statements.find((s) => ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(sf) === 'module.exports' && ts.isObjectLiteralExpression(s.expression.right));
    return last ? last.expression.right.properties.map((p) => p.name.getText(sf)) : null;
  };
  const probe = `
    const [main, wants, expectMain] = JSON.parse(process.argv[1]);
    const out = { bad: [] };
    for (const [file, names] of Object.entries(wants)) {
      const mod = require(file);
      if (typeof mod.bindMain !== 'function') out.bad.push(file + ': no bindMain');
      for (const n of names) if (typeof mod[n] === 'undefined') out.bad.push(file + ': missing ' + n);
    }
    const m = require(main);
    if (expectMain) for (const n of expectMain) if (!(n in m)) out.bad.push(main + ': export ' + n + ' is gone');
    console.log(JSON.stringify(out));`;
  const expectMain = exportsOf(parse(ts, original));
  const res = spawnSync(process.execPath, ['-e', probe, JSON.stringify([plan.source, wants, expectMain])], { cwd: plan.root, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  let bad = [];
  try { bad = JSON.parse(res.stdout.trim().split('\n').pop()).bad; } catch { bad = [`load failed: ${(res.stderr || '').split('\n').slice(0, 4).join(' ')}`]; }
  results.push({ check: 'loads', ok: res.status === 0 && !bad.length, detail: bad.length ? bad.slice(0, 8).join('; ') : `${featureList.length} folder files and ${path.basename(plan.source)} load; every name ${path.basename(plan.source)} takes is exported${expectMain ? `; all ${expectMain.length} original exports remain` : ''}` });
  // Wiring: every name a folder borrows is handed to it by bindMain.
  const wiringBad = [];
  for (const file of featureList) {
    const sf = parse(ts, fs.readFileSync(file, 'utf8'), file);
    const bind = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === 'bindMain');
    let borrowed = [];
    if (bind && bind.body) {
      const stmt = bind.body.statements[0];
      const assign = stmt && ts.isExpressionStatement(stmt) && (ts.isParenthesizedExpression(stmt.expression) ? stmt.expression.expression : stmt.expression);
      if (assign && ts.isBinaryExpression(assign) && ts.isObjectLiteralExpression(assign.left)) borrowed = assign.left.properties.map((p) => p.name.text);
    }
    const given = passes[file] || [];
    const lacking = borrowed.filter((n) => !given.includes(n));
    if (lacking.length) wiringBad.push(`${path.relative(plan.root, file)} never gets ${lacking.join(', ')}`);
    if (!passes[file]) wiringBad.push(`${path.relative(plan.root, file)} is never bound`);
  }
  results.push({ check: 'wiring', ok: !wiringBad.length, detail: wiringBad.length ? wiringBad.join('; ') : `every borrowed name in ${featureList.length} folder files is handed over by bindMain` });
  // Unresolved names: used but never defined. The count must not change.
  const before = unresolvedNames(ts, { '/split/original.js': original });
  const afterFiles = { [`/split/${path.basename(plan.source)}`]: mainText };
  for (const f of featureList) afterFiles[`/split/${path.relative(plan.root, f)}`] = fs.readFileSync(f, 'utf8');
  const after = unresolvedNames(ts, afterFiles, (name, sf) => {
    const isMain = name === `/split/${path.basename(plan.source)}`;
    const spans = sf.statements.filter((s) => (isMain ? isWiring(ts, sf, s, srcDir, plan.outDir)
      : !(ts.isFunctionDeclaration(s) && s.name && s.name.text !== 'bindMain'))).map((s) => [s.getFullStart(), s.getEnd()]);
    return (pos) => spans.some(([a, b]) => pos >= a && pos < b);
  });
  // A moved MAIN_DIR is the old __dirname, so it counts as that name when __dirname was unresolved before.
  for (const f of featureList) {
    for (const piece of featurePieces(ts, f, fs.readFileSync(f, 'utf8'))) {
      const sf = parse(ts, piece.text);
      const visit = (node) => {
        if (ts.isIdentifier(node) && !isNamePosition(ts, node)) {
          const old = node.text === 'MAIN_DIR' ? '__dirname' : node.text === 'MAIN_FILE' ? '__filename' : null;
          if (old && before.has(old)) after.set(old, (after.get(old) || 0) + 1);
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
  }
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((n) => (before.get(n) || 0) !== (after.get(n) || 0));
  results.push({ check: 'unresolved', ok: !changed.length, detail: `${total(before)} before (${before.size} names), ${total(after)} after (${after.size} names)${changed.length ? `; changed: ${changed.map((n) => `${n} ${before.get(n) || 0}->${after.get(n) || 0}`).join(', ')}` : ''}` });
  return { ok: results.every((r) => r.ok), results };
}

// ---------- docs ----------

function readmeFor(plan, f) {
  const sourceRel = path.relative(plan.root, plan.source).split(path.sep).join('/');
  const owner = f.name === 'core'
    ? 'Owner: shared. A change here needs a look from the owners of the folders that use it.'
    : f.owner ? `Owner: \`${f.owner}\` (${path.relative(plan.root, path.join(plan.teamDir || 'atris/team', f.owner, 'MEMBER.md')).split(path.sep).join('/')})` : 'Owner: unassigned';
  const uses = [...f.uses.map((u) => `[${u}](../${u}/README.md)`), ...(f.usesMain ? [`\`${sourceRel}\` itself`] : [])];
  return `# ${f.name}

${f.summary || ''}

${owner}

Moved out of \`${sourceRel}\` on ${plan.date}.

Uses code from: ${uses.length ? uses.join(', ') : 'nothing outside this folder'}.

## Files

### ${f.name}.js

Functions (${f.items.length}): ${f.items.map((i) => `\`${i.name}\``).join(', ')}

## How this folder works

This code moved out of \`${sourceRel}\` unchanged, except that \`__dirname\` became \`MAIN_DIR\` (the folder of \`${path.basename(plan.source)}\`) and relative requires point out of this folder. Every name it borrows, from \`${path.basename(plan.source)}\` or from another folder, arrives through \`bindMain()\`, which \`${path.basename(plan.source)}\` calls as the last step of loading. \`${path.basename(plan.source)}\` takes these functions back with one \`require\` near its top, so every old name still works there.

New work for this feature goes here, not in \`${path.basename(plan.source)}\`. To use a new name from outside this folder, add it to the \`let\` list and the \`bindMain\` list at the top of the file, and to this folder's \`bindMain({...})\` call at the bottom of \`${path.basename(plan.source)}\`.
`;
}

function indexReadme(plan, features, stats) {
  const sourceRel = path.relative(plan.root, plan.source).split(path.sep).join('/');
  const planRel = path.relative(plan.root, plan.planPath).split(path.sep).join('/');
  const rows = features.map((f) => `| [${f.name}](${f.name}/README.md) | ${f.name === 'core' ? 'shared' : (f.owner ? `\`${f.owner}\`` : 'unassigned')} | 1 | ${f.lineCount} | ${f.summary || ''} |`);
  return `# Feature folders of ${sourceRel}

\`${sourceRel}\` was ${stats.before} lines. On ${plan.date} \`${TOOL}\` moved ${stats.moved} functions out of it into these folders, each with an owner. ${stats.after} lines stay: the requires and constants, code that runs while the file loads, and the functions the plan keeps.

| Folder | Owner | Files | Lines | What it is |
|---|---|---|---|---|
${rows.join('\n')}

Shared code in \`core\` has no single owner: a change there needs a look from the owners of the folders that use it.

## How the split was made and proven

The plan is \`${planRel}\`. The order file \`${path.relative(plan.root, plan.order).split(path.sep).join('/')}\` lists every top-level piece of the original in its old position.

\`\`\`
node ${TOOL} analyze --plan ${planRel}
node ${TOOL} split   --plan ${planRel}
node ${TOOL} rebuild --plan ${planRel} --out /tmp/${path.basename(plan.source)}
node ${TOOL} verify  --plan ${planRel}
\`\`\`

\`verify\` rebuilds the original from these folders and diffs it, runs \`node --check\`, loads every file and counts names used but never defined. It proves the split itself; once someone edits a moved function, the rebuild differs from the original on purpose.
`;
}

function addMemberPointer(plan, f) {
  if (!plan.teamDir || !f.owner || f.name === 'core') return false;
  const file = path.join(plan.teamDir, f.owner, 'MEMBER.md');
  if (!fs.existsSync(file)) return false;
  const rel = `${path.relative(plan.root, path.dirname(f.file)).split(path.sep).join('/')}/`;
  const sourceRel = path.relative(plan.root, plan.source).split(path.sep).join('/');
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(`\`${rel}\``)) return false;
  const line = `- \`${rel}\`: ${f.summary || f.name} Moved out of \`${sourceRel}\` on ${plan.date}; read its README.md before changing it.`;
  if (/^## Code I own\s*$/m.test(text)) text = text.replace(/^## Code I own\s*\n(\n?)/m, (m) => `${m.trimEnd()}\n\n${line}\n`);
  else text = `${text.trimEnd()}\n\n## Code I own\n\n${line}\n`;
  fs.writeFileSync(file, text);
  return true;
}

// ---------- commands ----------

function summarize(plan, analysis, decision) {
  const rows = [];
  for (const f of plan.features) {
    const items = analysis.info.filter((i) => i.isFunction && decision.assigned.get(i.name) === f.name);
    if (items.length) rows.push({ feature: f.name, owner: f.name === 'core' ? 'shared' : (f.owner || 'unassigned'), functions: items.length, lines: items.reduce((a, i) => a + i.lines, 0) });
  }
  const staying = analysis.info.filter((i) => i.isFunction && !decision.assigned.has(i.name));
  return {
    lines: analysis.text.split('\n').length - (analysis.text.endsWith('\n') ? 1 : 0),
    functions: analysis.info.filter((i) => i.isFunction).length,
    features: rows,
    staying: staying.map((i) => ({ name: i.name, lines: i.lines, why: decision.pinned.get(i.name) || 'no feature reaches it' })),
  };
}

function cmdAnalyze(plan, ts, opts) {
  const analysis = analyzeSource(ts, fs.readFileSync(plan.source, 'utf8'));
  const decision = decide(plan, analysis);
  const summary = summarize(plan, analysis, decision);
  if (opts.json) { console.log(JSON.stringify({ ...summary, assigned: Object.fromEntries(decision.assigned), why: Object.fromEntries(decision.why) }, null, 2)); return 0; }
  console.log(`${path.relative(plan.root, plan.source)}: ${summary.lines} lines, ${summary.functions} functions`);
  for (const r of summary.features) console.log(`  ${r.feature.padEnd(18)} ${String(r.functions).padStart(4)} functions ${String(r.lines).padStart(6)} lines  owner ${r.owner}`);
  console.log(`  stays: ${summary.staying.length} functions, ${summary.staying.reduce((a, s) => a + s.lines, 0)} lines`);
  for (const s of summary.staying) console.log(`    ${s.name} (${s.lines}): ${s.why}`);
  if (opts.verbose) for (const f of plan.features) {
    const names = [...decision.assigned].filter(([, feat]) => feat === f.name).map(([n]) => `${n} [${decision.why.get(n)}]`);
    if (names.length) console.log(`\n${f.name}:\n  ${names.join('\n  ')}`);
  }
  return 0;
}

function cmdSplit(plan, ts) {
  if (fs.existsSync(plan.order)) throw new Error(`already split: ${path.relative(plan.root, plan.order)} exists`);
  checkOwners(plan);
  const text = fs.readFileSync(plan.source, 'utf8');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const frozen = frozenPath(sha);
  fs.mkdirSync(path.dirname(frozen), { recursive: true });
  if (!fs.existsSync(frozen)) { fs.writeFileSync(frozen, text); fs.chmodSync(frozen, 0o444); }
  const analysis = analyzeSource(ts, text);
  const decision = decide(plan, analysis);
  const { files, features } = buildSplit(plan, analysis, decision);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: plan.root, encoding: 'utf8' });
  const sourceRel = path.relative(plan.root, plan.source).split(path.sep).join('/');
  const order = { source: sourceRel, date: plan.date, sha256: sha, base: head.status === 0 ? head.stdout.trim() : null, keys: analysis.keys };
  // Prove the rebuild in memory before writing anything.
  const orderText = `${JSON.stringify(order, null, 1)}\n`;
  const check = rebuild(plan, ts, { ...files, [plan.order]: orderText });
  const diff = lineDiffCount(text, check.text);
  if (!diff.blankOnly || check.missing.length || check.extra.length) throw new Error(`rebuild would not match (${diff.lines} lines differ, ${check.missing.length} missing); nothing written`);
  for (const [file, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
  fs.writeFileSync(plan.order, orderText);
  const stats = { before: text.split('\n').length - 1, after: files[plan.source].split('\n').length - 1, moved: features.reduce((a, f) => a + f.items.length, 0) };
  for (const f of features) fs.writeFileSync(path.join(path.dirname(f.file), 'README.md'), readmeFor(plan, f));
  fs.writeFileSync(path.join(plan.outDir, 'README.md'), indexReadme(plan, features, stats));
  const pointed = features.filter((f) => addMemberPointer(plan, f)).map((f) => f.owner);
  console.log(`frozen original: ${frozen}`);
  console.log(`${sourceRel}: ${stats.before} -> ${stats.after} lines; ${stats.moved} functions moved into ${features.length} folders`);
  for (const f of features) console.log(`  ${path.relative(plan.root, f.file)}  ${f.lineCount} lines  owner ${f.name === 'core' ? 'shared' : (f.owner || 'unassigned')}`);
  if (pointed.length) console.log(`MEMBER.md pointers added: ${[...new Set(pointed)].join(', ')}`);
  return 0;
}

function cmdRebuild(plan, ts, opts) {
  const built = rebuild(plan, ts);
  if (opts.out) fs.writeFileSync(opts.out, built.text); else process.stdout.write(built.text);
  if (built.missing.length) console.error(`missing pieces: ${built.missing.join(', ')}`);
  return built.missing.length ? 1 : 0;
}

function cmdVerify(plan, ts, opts) {
  const out = verify(plan, ts, opts);
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else for (const r of out.results) console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.check.padEnd(10)} ${r.detail}`);
  return out.ok ? 0 : 1;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--verbose') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) { opts[a.slice(2)] = argv[i + 1]; i += 1; }
    else opts._.push(a);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const command = opts._[0];
  if (!command || !opts.plan || !['analyze', 'split', 'rebuild', 'verify'].includes(command)) {
    console.error('usage: node lib/split-file.js analyze|split|rebuild|verify --plan <plan.json> [--out file] [--original file] [--json] [--verbose]');
    return 2;
  }
  const plan = loadPlan(opts.plan);
  const ts = loadTypescript(plan.root);
  return { analyze: cmdAnalyze, split: cmdSplit, rebuild: cmdRebuild, verify: cmdVerify }[command](plan, ts, opts);
}

module.exports = { loadTypescript, loadPlan, analyzeSource, decide, buildSplit, rebuild, verify, moveSpec, statementKeys, pieceRanges };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(`split-file: ${err.message}`); process.exitCode = 1; }
}
