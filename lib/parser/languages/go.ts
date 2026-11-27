import { readFileSync } from "node:fs";
import path from "node:path";
import type { Role } from "../../roles.ts";
import type { ImportStatus } from "../types.ts";

export type GoImport = {
  specifier: string;
  line: number;
};

export type GoRoute = {
  file: string;
  method: string;
  pattern: string;
  line: number;
};

export type GoModuleInfo = {
  name: string;
  dependencies: Set<string>;
};

const FOLDER_ROLES: Record<string, Role> = {
  route: "router",
  routes: "router",
  router: "router",
  routers: "router",
  handler: "router",
  handlers: "router",
  controller: "controller",
  controllers: "controller",
  service: "service",
  services: "service",
  model: "model",
  models: "model",
  domain: "model",
  entity: "entity",
  entities: "entity",
  repository: "repository",
  repositories: "repository",
  store: "repository",
  middleware: "middleware",
  middlewares: "middleware",
  util: "util",
  utils: "util",
  helper: "util",
  helpers: "util",
  config: "config",
};

/** Read module name and dependencies from `go.mod` in a directory, if present. */
export function readGoMod(dir: string): GoModuleInfo | null {
  try {
    const content = readFileSync(path.join(dir, "go.mod"), "utf8");
    const modMatch = content.match(/^\s*module\s+(\S+)/m);
    if (!modMatch) return null;
    const name = modMatch[1].replace(/^["']|["']$/g, "");
    const dependencies = new Set<string>();
    for (const m of content.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s+v[0-9]/gm)) {
      dependencies.add(m[1]);
    }
    return { name, dependencies };
  } catch {
    return null;
  }
}

export function detectGoFramework(deps: ReadonlySet<string>): "Gin" | "Echo" | "Fiber" | "Chi" | "Go" {
  for (const d of deps) {
    if (d.includes("github.com/gin-gonic/gin")) return "Gin";
    if (d.includes("github.com/labstack/echo")) return "Echo";
    if (d.includes("github.com/gofiber/fiber")) return "Fiber";
    if (d.includes("github.com/go-chi/chi")) return "Chi";
  }
  return "Go";
}

/** Replace `//` and `/* ... *\/` comments with spaces/newlines so line numbers stay exact. */
function stripGoComments(content: string): string {
  return content.replace(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** Extract top-level exported Go identifiers and exported receiver methods. */
export function extractGoExports(content: string): string[] {
  const cleaned = stripGoComments(content);
  const exports: string[] = [];
  const seen = new Set<string>();

  for (const line of cleaned.split("\n")) {
    const top = line.match(/^(?:func|type|var|const)\s+([A-Z][A-Za-z0-9_]*)\b/);
    if (top && !seen.has(top[1])) {
      seen.add(top[1]);
      exports.push(top[1]);
      continue;
    }
    const method = line.match(/^func\s+\(\s*[A-Za-z_][A-Za-z0-9_]*\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+([A-Z][A-Za-z0-9_]*)\b/);
    if (method) {
      const sym = `${method[1]}.${method[2]}`;
      if (!seen.has(sym)) {
        seen.add(sym);
        exports.push(sym);
      }
    }
  }
  return exports;
}

/** Extract single and grouped Go `import` paths with 1-based line numbers. */
export function extractGoImports(content: string): GoImport[] {
  const cleaned = stripGoComments(content);
  const lines = cleaned.split("\n");
  const imports: GoImport[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const single = raw.match(/^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/);
    if (single) {
      imports.push({ specifier: single[1], line: i + 1 });
      continue;
    }

    if (/^\s*import\s*\(/.test(raw)) {
      if (raw.includes(")")) {
        const inline = raw.match(/"([^"]+)"/);
        if (inline) imports.push({ specifier: inline[1], line: i + 1 });
        continue;
      }
      while (i + 1 < lines.length) {
        i++;
        const inner = lines[i];
        const m = inner.match(/^\s*(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/);
        if (m) imports.push({ specifier: m[1], line: i + 1 });
        if (inner.includes(")")) break;
      }
    }
  }

  return imports;
}

/** Extract HTTP routes from Gin, Echo, Fiber, Chi, and net/http handlers. */
export function extractGoRoutes(filePath: string, content: string): GoRoute[] {
  const cleaned = stripGoComments(content);
  const lines = cleaned.split("\n");
  const routes: GoRoute[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Gin/Chi/Echo/Fiber: r.GET("/users", ...), app.Post("/items", ...)
    const verbMatch = line.match(/\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head|Any)\(\s*["']([^"']+)["']/);
    if (verbMatch) {
      const verb = verbMatch[1].toUpperCase();
      routes.push({
        file: filePath,
        method: verb === "ANY" ? "ALL" : verb,
        pattern: normalizeRoute(verbMatch[2]),
        line: lineNum,
      });
      continue;
    }

    // net/http or gorilla/mux: HandleFunc("/health", ...) / Handle("/...", ...)
    const handleMatch = line.match(/\.(?:HandleFunc|Handle)\(\s*["']([^"']+)["']/);
    if (handleMatch) {
      const methodsMatch = line.match(/\.Methods\(([^)]+)\)/);
      const methods = methodsMatch
        ? [...methodsMatch[1].matchAll(/["']([A-Za-z]+)["']/g)].map((m) => m[1].toUpperCase())
        : ["ALL"];
      for (const method of methods) {
        routes.push({ file: filePath, method, pattern: normalizeRoute(handleMatch[1]), line: lineNum });
      }
    }
  }

  return routes;
}

/** Infer a Go file's convention role and entry-point `reachedBy` label. */
export function goConventions(
  filePath: string,
  content: string,
  hasRoutes: boolean,
): { role: Role | null; reachedBy: string | null } {
  if (filePath.endsWith("_test.go")) {
    return { role: "test", reachedBy: "go test" };
  }

  const isMain = /^\s*package\s+main\b/m.test(content);
  if (isMain) {
    return { role: hasRoutes ? "api-endpoint" : null, reachedBy: "Go main package" };
  }

  const folders = filePath.split("/").slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    const role = FOLDER_ROLES[folders[i] ?? ""];
    if (role) {
      return {
        role,
        reachedBy: hasRoutes ? "Go HTTP handler" : null,
      };
    }
  }

  if (hasRoutes) return { role: "api-endpoint", reachedBy: "Go HTTP handler" };
  return { role: null, reachedBy: null };
}

/** Index non-test `.go` files (or all `.go` files as fallback) by repository-relative directory. */
export function indexGoPackages(goPaths: readonly string[]): Map<string, string> {
  const byDir = new Map<string, string[]>();
  for (const p of goPaths) {
    const dir = path.posix.dirname(p);
    const list = byDir.get(dir) ?? [];
    list.push(p);
    byDir.set(dir, list);
  }

  const primary = new Map<string, string>();
  for (const [dir, files] of byDir) {
    const nonTest = files.filter((f) => !f.endsWith("_test.go"));
    const pool = (nonTest.length > 0 ? nonTest : files).slice().sort();
    const dirBase = dir === "." ? "main.go" : `${path.posix.basename(dir)}.go`;
    const preferred = pool.find((f) => path.posix.basename(f) === dirBase) ?? pool[0];
    if (preferred) primary.set(dir, preferred);
  }
  return primary;
}

/** Resolve a Go import path against the module's packages and Go stdlib/external packages. */
export function resolveGoImport(
  specifier: string,
  moduleName: string | null,
  projectPath: string,
  goPackages: ReadonlyMap<string, string>,
): ImportStatus {
  if (moduleName && (specifier === moduleName || specifier.startsWith(`${moduleName}/`))) {
    const subDir = specifier === moduleName ? "" : specifier.slice(moduleName.length + 1);
    const relDir = projectPath === "." ? (subDir || ".") : (subDir ? `${projectPath}/${subDir}` : projectPath);
    const target = goPackages.get(relDir);
    if (target) return { status: "internal", target };
    return { status: "unresolved", reason: "file-not-found", detail: `no Go package found at ${relDir}` };
  }

  const firstSeg = specifier.split("/")[0];
  if (!firstSeg.includes(".")) {
    return { status: "external", external: "builtin" };
  }
  return { status: "external", external: "package" };
}

function normalizeRoute(pattern: string): string {
  const trimmed = pattern.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
