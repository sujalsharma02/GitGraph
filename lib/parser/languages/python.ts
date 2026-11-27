import path from "node:path";
import type { Role } from "../../roles.ts";
import type { EdgeKind, ImportStatus } from "../types.ts";

export type PythonImport = {
  /** Module specifier as written (e.g. "app.db" or ".utils"), or expression for dynamic imports. */
  specifier: string;
  /** Imported symbol names for `from ... import a, b` statements. */
  names: string[];
  kind: EdgeKind;
  literal: boolean;
  line: number;
};

export type PythonRoute = {
  file: string;
  method: string;
  pattern: string;
  line: number;
};

const PYTHON_STDLIB = new Set([
  "abc", "argparse", "array", "ast", "asyncio", "base64", "bisect", "builtins",
  "calendar", "cmath", "collections", "concurrent", "configparser", "contextlib",
  "contextvars", "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal",
  "difflib", "dis", "email", "enum", "errno", "faulthandler", "fcntl", "fileinput",
  "fnmatch", "fractions", "ftplib", "functools", "gc", "getopt", "getpass", "glob",
  "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache",
  "locale", "logging", "lzma", "math", "mimetypes", "mmap", "multiprocessing",
  "numbers", "operator", "os", "pathlib", "pickle", "platform", "plistlib",
  "poplib", "posixpath", "pprint", "profile", "pstats", "pty", "pwd", "queue",
  "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy",
  "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil",
  "signal", "site", "smtplib", "socket", "socketserver", "sqlite3", "ssl",
  "stat", "statistics", "string", "struct", "subprocess", "sys", "sysconfig",
  "tarfile", "tempfile", "termios", "textwrap", "threading", "time", "timeit",
  "tkinter", "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc",
  "tty", "turtle", "types", "typing", "unicodedata", "unittest", "urllib",
  "uuid", "venv", "warnings", "wave", "weakref", "webbrowser", "xml", "xmlrpc",
  "zipfile", "zipimport", "zlib", "zoneinfo",
]);

const FOLDER_ROLES: Record<string, Role> = {
  route: "router",
  routes: "router",
  router: "router",
  routers: "router",
  endpoint: "api-endpoint",
  endpoints: "api-endpoint",
  api: "router",
  service: "service",
  services: "service",
  model: "model",
  models: "model",
  schema: "dto",
  schemas: "dto",
  dto: "dto",
  dtos: "dto",
  repository: "repository",
  repositories: "repository",
  crud: "repository",
  middleware: "middleware",
  middlewares: "middleware",
  util: "util",
  utils: "util",
  helper: "util",
  helpers: "util",
  config: "config",
};

/** Replace triple-quoted strings and `#` comments with spaces/newlines so line numbers stay exact. */
function stripCommentsAndDocstrings(content: string): string {
  return content.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*)/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** Detect the primary Python framework from manifest dependency names. */
export function detectPythonFramework(deps: ReadonlySet<string>): "FastAPI" | "Flask" | "Django" | "Python" {
  if (deps.has("fastapi")) return "FastAPI";
  if (deps.has("flask")) return "Flask";
  if (deps.has("django")) return "Django";
  return "Python";
}

/** Extract top-level exported symbols (`__all__` if present, else public `def`/`class`/constants). */
export function extractPythonExports(content: string): string[] {
  const cleaned = stripCommentsAndDocstrings(content);
  const allMatch = cleaned.match(/^__all__\s*=\s*[\[(]([\s\S]*?)[\])]/m);
  if (allMatch) {
    const names = [...allMatch[1].matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((m) => m[1]);
    if (names.length > 0) return names;
  }

  const exports: string[] = [];
  const seen = new Set<string>();
  for (const line of cleaned.split("\n")) {
    const m =
      line.match(/^(?:async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/) ??
      line.match(/^([A-Z][A-Z0-9_]{2,})\s*=/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      exports.push(m[1]);
    }
  }
  return exports;
}

/** Extract `import`, `from ... import`, and `importlib.import_module` statements with 1-based line numbers. */
export function extractPythonImports(content: string, filePath?: string): PythonImport[] {
  const cleaned = stripCommentsAndDocstrings(content);
  const lines = cleaned.split("\n");
  const imports: PythonImport[] = [];
  const isInit = filePath ? path.posix.basename(filePath) === "__init__.py" : false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];

    // `import a, b.c as d`
    const impMatch = raw.match(/^\s*import\s+(.+)$/);
    if (impMatch) {
      for (const part of impMatch[1].split(",")) {
        const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (mod && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(mod)) {
          imports.push({ specifier: mod, names: [], kind: "import", literal: true, line: lineNum });
        }
      }
      continue;
    }

    // `from pkg import (a, b, ...)` (possibly multiline) or `from pkg import a, b`
    const fromStart = raw.match(/^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/);
    if (fromStart) {
      const specifier = fromStart[1];
      let rest = fromStart[2].trim();
      if (rest.startsWith("(") && !rest.includes(")")) {
        while (i + 1 < lines.length) {
          i++;
          rest += " " + lines[i].trim();
          if (lines[i].includes(")")) break;
        }
      }
      const inner = rest.replace(/^\(/, "").replace(/\).*$/, "");
      const hasStar = inner.trim() === "*";
      const names = inner
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim())
        .filter((s): s is string => Boolean(s && s !== "*" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)));
      const kind: EdgeKind = isInit || hasStar ? "re-export" : "import";
      imports.push({ specifier, names, kind, literal: true, line: lineNum });
      continue;
    }

    // `importlib.import_module("pkg.mod")` or dynamic `importlib.import_module(expr)`
    const dynMatch = raw.match(/importlib\.import_module\(\s*([^)]+)\)/);
    if (dynMatch) {
      const arg = dynMatch[1].trim();
      const lit = arg.match(/^["']([A-Za-z_][A-Za-z0-9_.]*)["']$/);
      imports.push({
        specifier: lit ? lit[1] : arg,
        names: [],
        kind: "dynamic-import",
        literal: Boolean(lit),
        line: lineNum,
      });
    }
  }

  return imports;
}

/** Extract FastAPI, Flask, and Django HTTP routes from a Python file. */
export function extractPythonRoutes(filePath: string, content: string): PythonRoute[] {
  const cleaned = stripCommentsAndDocstrings(content);
  const lines = cleaned.split("\n");
  const routes: PythonRoute[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // FastAPI / Flask decorators: @app.get("/users"), @router.post("/items"), @bp.route("/x", methods=["POST"])
    const dec = line.match(/^\s*@[A-Za-z_][A-Za-z0-9_.]*\.(get|post|put|patch|delete|options|head|api_route|route)\(\s*["']([^"']+)["'](.*)$/);
    if (dec) {
      const verb = dec[1].toUpperCase();
      const pattern = normalizeRoute(dec[2]);
      if (verb === "ROUTE" || verb === "API_ROUTE") {
        const methodsMatch = dec[3].match(/methods\s*=\s*[\[(]([^\])]+)[\])]/);
        const methods = methodsMatch
          ? [...methodsMatch[1].matchAll(/["']([A-Za-z]+)["']/g)].map((m) => m[1].toUpperCase())
          : ["GET"];
        for (const method of methods) routes.push({ file: filePath, method, pattern, line: lineNum });
      } else {
        routes.push({ file: filePath, method: verb, pattern, line: lineNum });
      }
      continue;
    }

    // Django urls.py: path("users/<int:id>/", ...) or re_path(r"^...", ...)
    if (path.posix.basename(filePath) === "urls.py") {
      const dj = line.match(/\b(?:path|re_path)\(\s*r?["']([^"']*)["']/);
      if (dj) {
        routes.push({ file: filePath, method: "ALL", pattern: normalizeRoute(dj[1]), line: lineNum });
      }
    }
  }

  return routes;
}

/** Infer a Python file's convention role and entry-point `reachedBy` label. */
export function pythonConventions(
  filePath: string,
  hasRoutes: boolean,
): { role: Role | null; reachedBy: string | null } {
  const base = path.posix.basename(filePath);
  const parts = filePath.split("/");
  const folders = parts.slice(0, -1);

  if (
    base.startsWith("test_") ||
    base.endsWith("_test.py") ||
    base === "conftest.py" ||
    folders.some((f) => f === "test" || f === "tests")
  ) {
    return { role: "test", reachedBy: "pytest / unittest" };
  }

  if (base === "main.py" || base === "app.py" || base === "manage.py" || base === "wsgi.py" || base === "asgi.py" || base === "__main__.py") {
    return { role: hasRoutes ? "api-endpoint" : null, reachedBy: "Python entry point" };
  }

  if (base === "config.py" || base === "settings.py") {
    return { role: "config", reachedBy: null };
  }

  for (let i = folders.length - 1; i >= 0; i--) {
    const role = FOLDER_ROLES[folders[i] ?? ""];
    if (role) {
      return {
        role,
        reachedBy: hasRoutes ? "Python HTTP route" : null,
      };
    }
  }

  if (base === "models.py") return { role: "model", reachedBy: null };
  if (base === "schemas.py") return { role: "dto", reachedBy: null };
  if (base === "views.py" || base === "urls.py" || base === "routes.py") {
    return { role: "router", reachedBy: hasRoutes ? "Python HTTP route" : null };
  }
  if (hasRoutes) return { role: "api-endpoint", reachedBy: "Python HTTP route" };

  return { role: null, reachedBy: null };
}

/** Resolve a Python import against the repository's `.py` files. */
export function resolvePythonImport(
  fromRepoPath: string,
  imp: PythonImport,
  nodes: ReadonlySet<string>,
): ImportStatus {
  const { specifier, names } = imp;

  if (specifier.startsWith(".")) {
    const dotsMatch = specifier.match(/^(\.+)(.*)$/);
    const dots = dotsMatch?.[1].length ?? 1;
    const rest = dotsMatch?.[2] ?? "";

    let baseDir = path.posix.dirname(fromRepoPath);
    for (let d = 1; d < dots; d++) {
      baseDir = path.posix.dirname(baseDir);
    }
    const relBase = rest ? path.posix.join(baseDir, rest.replace(/\./g, "/")) : baseDir;
    const normalized = relBase === "." ? "" : relBase.replace(/^\.\//, "");

    const target = matchPythonModule(normalized, names, nodes);
    if (target) return { status: "internal", target };
    return { status: "unresolved", reason: "file-not-found", detail: `no Python module found for ${specifier}` };
  }

  const modPath = specifier.replace(/\./g, "/");
  for (const prefix of ["", "src/"]) {
    const target = matchPythonModule(prefix + modPath, names, nodes);
    if (target) return { status: "internal", target };
  }

  const topPkg = specifier.split(".")[0];
  if (PYTHON_STDLIB.has(topPkg)) {
    return { status: "external", external: "builtin" };
  }
  return { status: "external", external: "package" };
}

function matchPythonModule(basePath: string, names: string[], nodes: ReadonlySet<string>): string | null {
  if (basePath) {
    if (nodes.has(`${basePath}.py`)) return `${basePath}.py`;
    for (const name of names) {
      if (nodes.has(`${basePath}/${name}.py`)) return `${basePath}/${name}.py`;
      if (nodes.has(`${basePath}/${name}/__init__.py`)) return `${basePath}/${name}/__init__.py`;
    }
    if (nodes.has(`${basePath}/__init__.py`)) return `${basePath}/__init__.py`;
  } else {
    for (const name of names) {
      if (nodes.has(`${name}.py`)) return `${name}.py`;
      if (nodes.has(`${name}/__init__.py`)) return `${name}/__init__.py`;
    }
  }
  return null;
}

function normalizeRoute(pattern: string): string {
  const trimmed = pattern.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
