import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reachability audit — does anything actually CALL the code we built?
 *
 * ATLAS's recurring bug is not broken code, it's unreachable code. In a single
 * day (2026-08-01) the same shape appeared six times: Reels rendered with no
 * publish step, `call:social` silently denied for weeks, `planWork` wired to
 * nothing, `cfo`/`knowledge`/`archaeologist` with no routes, leads marked
 * contacted with nothing sent. Every one had passing tests, because a unit test
 * proves a function is CORRECT — never that anyone REACHES it.
 *
 * This closes that gap. It reads the source as text (no TypeScript compiler
 * dependency, no build step) and answers one question per operation: is there a
 * call site for it anywhere outside its own package?
 *
 * ── Why text scanning is the right tool here ───────────────────────────────
 * A precise answer needs the type graph. But the six real bugs were all the
 * blunt case — an op with LITERALLY ZERO callers — which a regex finds just as
 * well as a compiler, at a fraction of the complexity. Where this is imprecise
 * it is imprecise in a known direction: it can report an op as unreachable when
 * it's actually dispatched dynamically. That is why the audit pairs with an
 * allowlist that demands a written reason rather than trying to be perfect.
 */

export interface SourceFile {
  /** Package directory name, e.g. "wholesale". */
  pkg: string;
  /** Path as given, used in failure messages. */
  path: string;
  src: string;
}

export interface ProvidedOp {
  service: string;
  op: string;
  pkg: string;
  path: string;
}

export interface CallSite {
  service: string;
  /** null when the op could not be read as a literal at this site. */
  op: string | null;
  pkg: string;
  path: string;
  snippet: string;
}

export interface AuditResult {
  provided: ProvidedOp[];
  /** "service.op" keys that have at least one call site outside their own package. */
  reached: Set<string>;
  /** Provided ops with no external call site — the finding. */
  unreachable: ProvidedOp[];
  /**
   * Call sites on an op-taking service where no literal op could be read.
   * Services that declare no ops at all (brain takes {prompt, system}) are
   * excluded — a missing op there is correct, not suspicious.
   */
  unresolvedSites: CallSite[];
}

/** Read every .ts file under packages/<name>/src. */
export function loadSourceFiles(packagesRoot: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const pkg of readdirSync(packagesRoot)) {
    const srcDir = join(packagesRoot, pkg, "src");
    if (!existsSync(srcDir)) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) out.push({ pkg, path: p, src: readFileSync(p, "utf8") });
      }
    };
    walk(srcDir);
  }
  return out;
}

/**
 * Every (service, op) a plugin declares.
 *
 * Services are declared with `ctx.provide("name", handler)` and ops are
 * dispatched inside the handler by comparing `cmd.op`. Because several plugins
 * provide more than one service in a single file, each `provide(...)` claims
 * the text from its own position up to the next one — so an op is attributed to
 * the service whose handler actually contains it.
 */
export function extractProvidedOps(files: SourceFile[]): ProvidedOp[] {
  const seen = new Set<string>();
  const out: ProvidedOp[] = [];
  for (const f of files) {
    const marks: Array<{ service: string; at: number }> = [];
    for (const m of f.src.matchAll(/provide\(\s*"([a-zA-Z-]+)"/g)) {
      marks.push({ service: m[1]!, at: m.index! });
    }
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i]!.at;
      const end = i + 1 < marks.length ? marks[i + 1]!.at : f.src.length;
      const body = f.src.slice(start, end);
      const ops = new Set<string>();
      for (const m of body.matchAll(/op === "([a-zA-Z]+)"/g)) ops.add(m[1]!);
      for (const m of body.matchAll(/case "([a-zA-Z]+)":/g)) ops.add(m[1]!);
      for (const op of ops) {
        const key = `${marks[i]!.service}.${op}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ service: marks[i]!.service, op, pkg: f.pkg, path: f.path });
      }
    }
  }
  return out;
}

/**
 * Every place a service is invoked. Three dispatch shapes exist in this
 * codebase and all three must be recognised, because missing one manufactures
 * false "unreachable" reports that erode trust in the audit:
 *
 *   A. `invoke("svc", { op: "x" })` / `ctx.call("svc", { op: "x" })` — the
 *      common form, used by routes and by plugin-to-plugin calls.
 *   B. `op: expr as "approve" | "reject"` — the approvals decision route picks
 *      the op from the URL and narrows it with a union assertion. The union
 *      members ARE the reachable ops, so they're read straight out of it.
 *   C. `{ service: "svc", payload: { op: "x" } }` — the chat-intent table in
 *      server.ts routes a matched phrase to a service without calling invoke
 *      at that spot at all.
 */
export function extractCallSites(files: SourceFile[]): CallSite[] {
  const out: CallSite[] = [];
  for (const f of files) {
    // A + B
    for (const m of f.src.matchAll(/(?:invoke|call)\(\s*"([a-zA-Z]+)"/g)) {
      const service = m[1]!;
      // A generous window: payload object literals in this codebase routinely
      // run several lines, and stopping short would silently drop the op.
      const win = f.src.slice(m.index!, m.index! + 700);
      const snippet = win.slice(0, 120).replace(/\s+/g, " ");
      const literal = win.match(/\bop:\s*"([a-zA-Z]+)"/);
      const union = win.match(/\bop:[^,}\n]*?\bas\s+((?:"[a-zA-Z]+"\s*\|\s*)*"[a-zA-Z]+")/);
      if (literal) out.push({ service, op: literal[1]!, pkg: f.pkg, path: f.path, snippet });
      if (union) {
        for (const u of union[1]!.matchAll(/"([a-zA-Z]+)"/g)) {
          out.push({ service, op: u[1]!, pkg: f.pkg, path: f.path, snippet });
        }
      }
      if (!literal && !union) out.push({ service, op: null, pkg: f.pkg, path: f.path, snippet });
    }
    // C
    for (const m of f.src.matchAll(/service:\s*"([a-zA-Z]+)"/g)) {
      const win = f.src.slice(m.index!, m.index! + 400);
      for (const o of win.matchAll(/\bop:\s*"([a-zA-Z]+)"/g)) {
        out.push({ service: m[1]!, op: o[1]!, pkg: f.pkg, path: f.path, snippet: win.slice(0, 120).replace(/\s+/g, " ") });
      }
    }
  }
  return out;
}

/** Stable "service.op" key used everywhere an op is identified. */
export const opKey = (service: string, op: string): string => `${service}.${op}`;

/**
 * Every secret name some capability actually reads.
 *
 * Both access paths count. Most plugins go through `ctx.secret("NAME")` so the
 * value comes from the encrypted vault, but a few read `process.env.NAME`
 * directly (media-factory's Postgres pool needs a connection string before any
 * plugin context exists). Counting only the first would wrongly flag the second
 * as dead.
 */
export function extractSecretReaders(files: SourceFile[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const note = (name: string, pkg: string): void => {
    const list = out.get(name) ?? [];
    if (!list.includes(pkg)) list.push(pkg);
    out.set(name, list);
  };
  for (const f of files) {
    for (const m of f.src.matchAll(/secret\(\s*"([A-Z][A-Z0-9_]*)"/g)) note(m[1]!, f.pkg);
    for (const m of f.src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) note(m[1]!, f.pkg);
    for (const m of f.src.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) note(m[1]!, f.pkg);

    // Table-driven lookup, as in connectors:
    //   const TOKEN_NAME = { github: "GITHUB_TOKEN", vercel: "VERCEL_TOKEN" };
    //   await ctx.secret(TOKEN_NAME[name]);
    // The name never appears next to secret(), so the patterns above miss it
    // and the key looks dead. When a file resolves a secret name dynamically,
    // credit every key-shaped literal in that file. Deliberately scoped to such
    // files: applied everywhere it would match ordinary constants and quietly
    // mark genuinely dead keys as live.
    if (/secret\(\s*[^"')\s]/.test(f.src)) {
      for (const m of f.src.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)) note(m[1]!, f.pkg);
    }
  }
  return out;
}

export interface CapabilityStatus {
  service: string;
  pkg: string;
  /** Every op the service declares. */
  ops: string[];
  /** Ops nothing outside the package calls — dead weight, listed by name. */
  unreachableOps: string[];
  /** Secrets the owning package reads, and whether the vault holds one. */
  secrets: Array<{ name: string; present: boolean }>;
  status: "ready" | "needs-key" | "unreachable" | "partial";
  detail: string;
}

/**
 * Per-service honest status.
 *
 * The audit answers "can anything call this?". This answers the question Mat
 * actually has: "will this work if I press the button?" A capability can be
 * perfectly wired and still do nothing because its API key was never set —
 * surplus looked healthy for weeks while being unable to trace a single lead,
 * and the only way to find out was to run it and read the error.
 *
 * `vaultNames` is what the vault currently holds. Values never enter here.
 */
export function capabilityReport(files: SourceFile[], vaultNames: string[]): CapabilityStatus[] {
  const audit = auditReachability(files);
  const readers = extractSecretReaders(files);
  const held = new Set(vaultNames);

  // Secrets are attributed per package, since a plugin's ops share whatever
  // credentials that package reads.
  const pkgSecrets = new Map<string, Set<string>>();
  for (const [name, pkgs] of readers) {
    for (const pkg of pkgs) {
      if (!pkgSecrets.has(pkg)) pkgSecrets.set(pkg, new Set());
      pkgSecrets.get(pkg)!.add(name);
    }
  }

  const byService = new Map<string, { pkg: string; ops: string[] }>();
  for (const p of audit.provided) {
    if (!byService.has(p.service)) byService.set(p.service, { pkg: p.pkg, ops: [] });
    byService.get(p.service)!.ops.push(p.op);
  }
  const unreachable = new Set(audit.unreachable.map((u) => opKey(u.service, u.op)));

  const out: CapabilityStatus[] = [];
  for (const [service, { pkg, ops }] of byService) {
    const dead = ops.filter((op) => unreachable.has(opKey(service, op))).sort();
    const secrets = [...(pkgSecrets.get(pkg) ?? [])].sort().map((name) => ({ name, present: held.has(name) }));
    const missing = secrets.filter((s) => !s.present).map((s) => s.name);

    let status: CapabilityStatus["status"];
    let detail: string;
    if (dead.length === ops.length) {
      status = "unreachable";
      detail = `No route, cycle step, or plugin calls any of its ${ops.length} op(s).`;
    } else if (missing.length) {
      // Reported as needs-key rather than ready even when only some ops need
      // the secret: claiming "ready" and then failing at the API call is the
      // dishonesty this endpoint exists to remove.
      status = "needs-key";
      detail = `Wired, but missing ${missing.join(", ")}.`;
    } else if (dead.length) {
      status = "partial";
      detail = `${dead.length} of ${ops.length} op(s) unreachable: ${dead.join(", ")}.`;
    } else {
      status = "ready";
      detail = `${ops.length} op(s), all reachable${secrets.length ? `, ${secrets.length} secret(s) present` : ""}.`;
    }
    out.push({ service, pkg, ops: ops.sort(), unreachableOps: dead, secrets, status, detail });
  }

  const rank: Record<CapabilityStatus["status"], number> = { unreachable: 0, "needs-key": 1, partial: 2, ready: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.service.localeCompare(b.service));
}

export function auditReachability(files: SourceFile[]): AuditResult {
  const provided = extractProvidedOps(files);
  const sites = extractCallSites(files);

  // Which package owns each service — a call from inside the owning package
  // does not make an op reachable. A plugin calling its own op is an internal
  // detail; the question is whether anything OUTSIDE can trigger it.
  const owner = new Map<string, string>();
  for (const p of provided) if (!owner.has(p.service)) owner.set(p.service, p.pkg);

  const reached = new Set<string>();
  for (const s of sites) {
    if (!s.op) continue;
    if (owner.get(s.service) === s.pkg) continue;
    reached.add(opKey(s.service, s.op));
  }

  const unreachable = provided.filter((p) => !reached.has(opKey(p.service, p.op)));

  // Only services that declare ops can have a "missing op" problem. `brain`
  // takes { prompt, system } and no op at all, so every call to it lands here
  // and would otherwise drown the real signal.
  const opTaking = new Set(provided.map((p) => p.service));
  const unresolvedSites = sites.filter((s) => s.op === null && opTaking.has(s.service));

  return { provided, reached, unreachable, unresolvedSites };
}
