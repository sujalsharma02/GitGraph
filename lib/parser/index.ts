import { statSync } from "node:fs";
import path from "node:path";
import { Project, ts } from "ts-morph";
import { extractExports, extractImports } from "./extract.ts";
import { dedupeEdges, fanCounts } from "./graph.ts";
import {
  extractGoExports,
  extractGoImports,
  extractGoRoutes,
  goConventions,
  indexGoPackages,
  resolveGoImport,
} from "./languages/go.ts";
import {
  extractPythonExports,
  extractPythonImports,
  extractPythonRoutes,
  pythonConventions,
  resolvePythonImport,
} from "./languages/python.ts";
import { createResolver } from "./resolve.ts";
import {
  SCHEMA_VERSION,
  type Coverage,
  type Edge,
  type ImportStatus,
  type ParseResult,
  type ParsedFile,
  type Route,
  type SkippedFile,
  type StatusCounts,
} from "./types.ts";
import type { Role } from "../roles.ts";
import type { AdapterFile } from "./adapters/types.ts";
import { walkRepository, withinProject, type WalkResult } from "./walk.ts";

export type Selection = { root: string; walk: WalkResult };

export function parseRepository(directory: string): ParseResult {
  return parseSelection(selectFiles(directory));
}

// Selecting and parsing are separate calls so a caller can report which one
// it's in; together they are exactly parseRepository.
export function selectFiles(directory: string): Selection {
  const root = path.resolve(directory);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  return { root, walk: walkRepository(root) };
}

export function parseSelection({ root, walk }: Selection): ParseResult {

  const tsCandidates = walk.candidates.filter((c) => !c.path.endsWith(".py") && !c.path.endsWith(".go"));
  const pyCandidates = walk.candidates.filter((c) => c.path.endsWith(".py"));
  const goCandidates = walk.candidates.filter((c) => c.path.endsWith(".go"));

  // Parsing only: no lib, no type resolution. Imports are resolved separately
  // so every outcome can be classified rather than left to the compiler.
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [] },
  });
  const sourceFiles = tsCandidates.map((candidate) => ({
    candidate,
    sourceFile: project.createSourceFile(candidate.absolutePath, candidate.content, { overwrite: true }),
  }));
  const program = project.getProgram();

  const skipped: SkippedFile[] = [...walk.skipped];
  const parsedTs: typeof sourceFiles = [];
  for (const entry of sourceFiles) {
    const [first, ...rest] = program.getSyntacticDiagnostics(entry.sourceFile);
    if (!first) {
      parsedTs.push(entry);
      continue;
    }
    // A file that doesn't parse cleanly would give a partial import list. Absent beats approximate.
    const message = ts.flattenDiagnosticMessageText(first.compilerObject.messageText, " ");
    skipped.push({
      path: entry.candidate.path,
      reason: "syntax-error",
      detail: `line ${first.getLineNumber() ?? "?"}: ${message}${rest.length ? ` (+${rest.length} more)` : ""}`,
    });
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  const allParsed = [
    ...parsedTs.map((entry) => entry.candidate),
    ...pyCandidates,
    ...goCandidates,
  ];
  const nodeSet = new Set(allParsed.map((c) => c.path));

  const resolver = createResolver({
    root,
    nodes: nodeSet,
    skipped: new Map(skipped.map((file) => [file.path, file])),
    excludedDirectories: walk.excludedDirectories,
    workspacePackages: walk.workspacePackages,
  });

  const coverage: Coverage["imports"] = {
    total: emptyCounts(),
    byKind: { import: emptyCounts(), "re-export": emptyCounts(), "dynamic-import": emptyCounts(), require: emptyCounts() },
    external: { package: 0, builtin: 0, "outside-root": 0 },
    excluded: {},
    unresolvedByReason: {},
    unresolved: [],
  };
  const rawEdges: Edge[] = [];
  const exportsOf = new Map<string, string[]>();

  const recordOutcome = (
    fromPath: string,
    kind: Edge["kind"],
    typeOnly: boolean,
    specifier: string,
    line: number,
    outcome: ImportStatus,
  ) => {
    coverage.total.seen++;
    coverage.byKind[kind].seen++;
    coverage.total[outcome.status]++;
    coverage.byKind[kind][outcome.status]++;

    switch (outcome.status) {
      case "internal":
        rawEdges.push({ source: fromPath, target: outcome.target, kind, typeOnly, specifier, line });
        break;
      case "external":
        coverage.external[outcome.external]++;
        break;
      case "excluded":
        coverage.excluded[outcome.reason] = (coverage.excluded[outcome.reason] ?? 0) + 1;
        break;
      case "unresolved":
        coverage.unresolvedByReason[outcome.reason] = (coverage.unresolvedByReason[outcome.reason] ?? 0) + 1;
        coverage.unresolved.push({
          from: fromPath,
          specifier,
          kind,
          line,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        break;
    }
  };

  for (const { candidate, sourceFile } of parsedTs) {
    exportsOf.set(candidate.path, extractExports(sourceFile));
    for (const found of extractImports(sourceFile)) {
      const specifier = found.literal ? found.specifier : found.expression;
      const outcome: ImportStatus = found.literal
        ? resolver.resolve(candidate.absolutePath, found.specifier, found.kind)
        : {
            status: "unresolved",
            reason: found.kind === "require" ? "non-literal-require" : "non-literal-dynamic-import",
            detail: "the path is computed at runtime",
          };
      recordOutcome(candidate.path, found.kind, found.typeOnly, specifier, found.line, outcome);
    }
  }

  const extraRoles = new Map<string, Role>();
  const extraReachedBy = new Map<string, string>();
  const extraRoutes: Route[] = [];

  for (const candidate of pyCandidates) {
    exportsOf.set(candidate.path, extractPythonExports(candidate.content));
    const pyRoutes = extractPythonRoutes(candidate.path, candidate.content);
    extraRoutes.push(...pyRoutes);
    const conv = pythonConventions(candidate.path, pyRoutes.length > 0);
    if (conv.role) extraRoles.set(candidate.path, conv.role);
    if (conv.reachedBy) extraReachedBy.set(candidate.path, conv.reachedBy);

    for (const found of extractPythonImports(candidate.content, candidate.path)) {
      const outcome: ImportStatus = found.literal
        ? resolvePythonImport(candidate.path, found, nodeSet)
        : {
            status: "unresolved",
            reason: "non-literal-dynamic-import",
            detail: "the module name is computed at runtime",
          };
      recordOutcome(candidate.path, found.kind, false, found.specifier, found.line, outcome);
    }
  }

  if (goCandidates.length > 0) {
    const goPackages = indexGoPackages(goCandidates.map((c) => c.path));
    for (const candidate of goCandidates) {
      exportsOf.set(candidate.path, extractGoExports(candidate.content));
      const goRoutes = extractGoRoutes(candidate.path, candidate.content);
      extraRoutes.push(...goRoutes);
      const conv = goConventions(candidate.path, candidate.content, goRoutes.length > 0);
      if (conv.role) extraRoles.set(candidate.path, conv.role);
      if (conv.reachedBy) extraReachedBy.set(candidate.path, conv.reachedBy);

      const goModule = walk.goModules.get(candidate.project) ?? null;
      for (const found of extractGoImports(candidate.content)) {
        const outcome = resolveGoImport(found.specifier, goModule, candidate.project, goPackages);
        recordOutcome(candidate.path, "import", false, found.specifier, found.line, outcome);
      }
    }
  }

  const edges = dedupeEdges(rawEdges);
  const paths = allParsed.map((candidate) => candidate.path);
  const fan = fanCounts(paths, edges);
  const conventions = applyAdapters(walk, parsedTs, skipped);
  const allRoutes = mergeRoutes(conventions.routes, extraRoutes);
  const files: ParsedFile[] = allParsed
    .map((candidate) => ({
      path: candidate.path,
      module: candidate.module,
      lines: candidate.lines,
      bytes: candidate.bytes,
      hash: candidate.hash,
      fanIn: fan.get(candidate.path)?.fanIn ?? 0,
      fanOut: fan.get(candidate.path)?.fanOut ?? 0,
      reachedBy: extraReachedBy.get(candidate.path) ?? candidate.reachedBy,
      role: extraRoles.get(candidate.path) ?? conventions.roles.get(candidate.path) ?? null,
      exports: exportsOf.get(candidate.path) ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length + skipped.length !== walk.found) {
    throw new Error(`Coverage doesn't add up: found ${walk.found}, parsed ${files.length}, skipped ${skipped.length}`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    projects: walk.projects,
    files,
    edges,
    routes: allRoutes,
    coverage: {
      files: {
        found: walk.found,
        parsed: files.length,
        skipped: skipped.length,
        skippedFiles: skipped,
        excludedDirectories: walk.excludedDirectories,
      },
      imports: coverage,
      routes: { omitted: conventions.omitted, withheld: conventions.withheld },
    },
    configs: resolver.configs(),
  };
}

// Each project's adapter is asked about its own files, by project-relative
// path, and what it answers is mapped back to repository paths.
function applyAdapters(
  walk: WalkResult,
  parsed: readonly { candidate: { path: string; project: string }; sourceFile: AdapterFile["source"] }[],
  skipped: readonly SkippedFile[],
) {
  const roles = new Map<string, Role>();
  const routes: Route[] = [];
  const omitted: Coverage["routes"]["omitted"] = [];
  const withheld: Coverage["routes"]["withheld"] = [];

  for (const [project, adapter] of walk.adapters) {
    const toRepo = (p: string) => (project === "." ? p : `${project}/${p}`);
    const files: AdapterFile[] = [];
    for (const { candidate, sourceFile } of parsed) {
      if (candidate.project !== project) continue;
      const file = { path: withinProject(project, candidate.path), source: sourceFile };
      files.push(file);
      const role = adapter.roleOf(file);
      if (role) roles.set(candidate.path, role);
    }
    // A declaration file has no runtime code, so it can't hold anything an adapter reads.
    const unparsed = skipped
      .filter((f) => f.reason !== "declaration-file" && walk.projectOf.get(f.path) === project)
      .map((f) => withinProject(project, f.path));

    const report = adapter.routes({ files, unparsed });
    if (report.withheld !== null) {
      withheld.push({ project, reason: report.withheld });
      continue;
    }
    for (const r of report.routes) routes.push({ file: toRepo(r.path), method: r.method, pattern: r.pattern, line: r.line });
    for (const o of report.omitted) omitted.push({ file: toRepo(o.path), line: o.line, reason: o.reason });
  }

  // An array of paths on a decorator can name the same one twice.
  const unique = new Map(routes.map((r) => [`${r.method} ${r.pattern} ${r.file}`, r]));
  return {
    roles,
    routes: [...unique.values()].sort(
      (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file),
    ),
    omitted: omitted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    withheld,
  };
}

function mergeRoutes(a: readonly Route[], b: readonly Route[]): Route[] {
  const unique = new Map<string, Route>();
  for (const r of [...a, ...b]) {
    unique.set(`${r.method} ${r.pattern} ${r.file}`, r);
  }
  return [...unique.values()].sort(
    (x, y) => x.pattern.localeCompare(y.pattern) || x.method.localeCompare(y.method) || x.file.localeCompare(y.file),
  );
}

function emptyCounts(): StatusCounts {
  return { seen: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 };
}

export type * from "./types.ts";
