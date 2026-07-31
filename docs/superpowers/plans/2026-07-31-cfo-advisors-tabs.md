# CFO + Advisors Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give four fully-built, already-registered ops (`cfo.forecast`, `cfo.roi`, `knowledge.playbook`, `archaeologist.dig`) a real route and a real button, so Mat can actually use them instead of them sitting unreachable.

**Architecture:** Four new HTTP routes in `packages/server/src/server.ts` (same `a.invoke(service, {op, ...})` try/catch pattern used by every existing route in that file), plus two new tabs (`CFO`, `Advisors`) in `packages/server/src/html.ts` that call those routes via the existing client-side `api()` helper and render the results.

**Tech Stack:** TypeScript, Node's built-in `http` module (no framework — see the existing routing `if` chain in `server.ts`), Vitest, vanilla JS served as a template-literal string (`html.ts`).

**Design doc:** `docs/superpowers/specs/2026-07-31-cfo-advisors-tabs-design.md`

---

### Task 1: CFO routes (`forecast`, `roi`)

**Files:**
- Modify: `packages/server/src/server.ts` (insert after line 1319, right after the `/api/media-factory/analytics` POST block ends, before the `// Self-improvement endpoints` comment)
- Test: `packages/server/test/server.test.ts` (add new `it` blocks inside the existing `describe("control panel", ...)` block, after the last existing test)

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/server.test.ts`, right before the final closing `});` of the `describe("control panel", ...)` block:

```typescript
  it("POST /api/cfo/forecast runs the forecast with Mat-supplied inputs", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/forecast", { cashOnHand: 10000, monthlyRevenue: 4000, monthlyExpenses: 5000 }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { netMonthly: number; runwayMonths: number | null; verdict: string };
    expect(body.netMonthly).toBe(-1000);
    expect(body.runwayMonths).toBe(10);
    expect(body.verdict).toBe("healthy");
  });

  it("POST /api/cfo/forecast rejects a missing required field", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/forecast", { cashOnHand: 10000 }, token);
    expect(r.status).toBe(400);
  });

  it("POST /api/cfo/roi calculates ROI", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/roi", { cost: 100, expectedReturn: 150 }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { roi: number };
    expect(body.roi).toBe(0.5);
  });

  it("POST /api/cfo/roi rejects a missing required field", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/roi", { cost: 100 }, token);
    expect(r.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/server test -- server.test.ts -t "cfo"`
Expected: FAIL — 404 (routes don't exist yet), not the asserted status codes.

- [ ] **Step 3: Implement the routes**

In `packages/server/src/server.ts`, insert this block immediately after line 1319 (the closing `}` of the `/api/media-factory/analytics` POST handler) and before the `// Self-improvement endpoints (ATLAS modifies itself)` comment:

```typescript
    // CFO + Advisors on-demand endpoints — cfo.forecast/roi and
    // knowledge.playbook/archaeologist.dig are fully built ops with no
    // route until now; same try/catch shape as every route above.
    if (method === "POST" && path === "/api/cfo/forecast") {
      try {
        const body = await readBody(req);
        if (body?.cashOnHand === undefined || body?.monthlyExpenses === undefined) {
          return send(res, 400, { error: "cashOnHand and monthlyExpenses are required" });
        }
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("cfo", {
          op: "forecast",
          inputs: {
            cashOnHand: Number(body.cashOnHand),
            monthlyExpenses: Number(body.monthlyExpenses),
            monthlyRevenue: body.monthlyRevenue !== undefined ? Number(body.monthlyRevenue) : undefined,
          },
        }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/cfo/roi") {
      try {
        const body = await readBody(req);
        if (body?.cost === undefined || body?.expectedReturn === undefined) {
          return send(res, 400, { error: "cost and expectedReturn are required" });
        }
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("cfo", { op: "roi", cost: Number(body.cost), expectedReturn: Number(body.expectedReturn) }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atlas/server test -- server.test.ts -t "cfo"`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "feat(server): add POST /api/cfo/forecast and /api/cfo/roi routes"
```

---

### Task 2: Knowledge + Archaeologist routes

**Files:**
- Modify: `packages/server/src/server.ts` (insert immediately after Task 1's new block, same location)
- Test: `packages/server/test/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/server.test.ts`, after the CFO tests from Task 1:

```typescript
  it("POST /api/knowledge/playbook returns a playbook for a topic", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/knowledge/playbook", { topic: "cold outreach" }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { title: string; sections: unknown[] };
    expect(body.title).toBe("Playbook: cold outreach");
    expect(Array.isArray(body.sections)).toBe(true);
  });

  it("POST /api/knowledge/playbook rejects a missing topic", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/knowledge/playbook", {}, token);
    expect(r.status).toBe(400);
  });

  it("POST /api/archaeologist/dig returns findings", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/archaeologist/dig", { topic: "old ideas" }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { findings: string };
    expect(typeof body.findings).toBe("string");
  });

  it("POST /api/archaeologist/dig works with no topic given", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/archaeologist/dig", {}, token);
    expect(r.status).toBe(200);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/server test -- server.test.ts -t "playbook|dig"`
Expected: FAIL — 404, routes don't exist yet.

- [ ] **Step 3: Implement the routes**

In `packages/server/src/server.ts`, insert this block right after Task 1's `/api/cfo/roi` block (still before `// Self-improvement endpoints`):

```typescript
    if (method === "POST" && path === "/api/knowledge/playbook") {
      try {
        const body = await readBody(req);
        if (!body?.topic) return send(res, 400, { error: "topic is required" });
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("knowledge", { op: "playbook", topic: String(body.topic), limit: body.limit !== undefined ? Number(body.limit) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/archaeologist/dig") {
      try {
        const body = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("archaeologist", { op: "dig", topic: body?.topic ? String(body.topic) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atlas/server test -- server.test.ts -t "playbook|dig"`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "feat(server): add POST /api/knowledge/playbook and /api/archaeologist/dig routes"
```

---

### Task 3: CFO tab UI

**Files:**
- Modify: `packages/server/src/html.ts` (nav button ~line 147, tab-array entry ~line 683, new `<section>` after the `tab-media-factory` section closes, new JS functions near `mfRunAutoCycle`)
- Test: `packages/server/test/page-script.test.ts` (existing test, no new test needed — just must keep passing)

- [ ] **Step 1: Add the nav button and tab-array entry**

In `packages/server/src/html.ts`, change line 149 from:

```html
      <button data-tab="media-factory">🎬 Media Factory</button>
```

to:

```html
      <button data-tab="media-factory">🎬 Media Factory</button>
      <button data-tab="cfo">💰 CFO</button>
```

Then change line 683's tab array from:

```javascript
["chat","map","businesses","learn","connect","grow","vault","keys","run","brief","actions","proposals","approvals","media-factory","gigs","kdp"].forEach(t => { const el=$("tab-"+t); if(el) el.classList.toggle("hide", t!==b.dataset.tab); });
```

to:

```javascript
["chat","map","businesses","learn","connect","grow","vault","keys","run","brief","actions","proposals","approvals","media-factory","gigs","kdp","cfo"].forEach(t => { const el=$("tab-"+t); if(el) el.classList.toggle("hide", t!==b.dataset.tab); });
```

- [ ] **Step 2: Add the CFO section**

Find the end of the `tab-media-factory` section (it closes with `</section>` right before `<section id="tab-vault"` or wherever the next section starts — locate it by searching for the first `</section>` after line 477 in the current file, since exact line numbers shift once Task 1/2 edits land). Insert this new section immediately after that closing `</section>`:

```html
    <section id="tab-cfo" class="card hide">
      <h2>💰 CFO</h2>
      <p class="note" style="margin-bottom:14px">Cash forecast and ROI math — nothing here is automatic, run it whenever you want a real number.</p>

      <h3>Forecast</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div><label>Cash on hand ($)</label><input id="cfoCash" type="number" style="width:140px" /></div>
        <div><label>Monthly revenue ($, optional)</label><input id="cfoRevenue" type="number" style="width:140px" placeholder="auto-filled if blank" /></div>
        <div><label>Monthly expenses ($)</label><input id="cfoExpenses" type="number" style="width:140px" /></div>
        <button onclick="cfoRunForecast()">Run Forecast</button>
      </div>
      <div id="cfoForecastOut"></div>

      <h3 style="margin-top:20px">ROI Calculator</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div><label>Cost ($)</label><input id="cfoCost" type="number" style="width:140px" /></div>
        <div><label>Expected return ($)</label><input id="cfoReturn" type="number" style="width:140px" /></div>
        <button onclick="cfoCalcRoi()">Calculate ROI</button>
      </div>
      <div id="cfoRoiOut"></div>
    </section>
```

- [ ] **Step 3: Add the CFO JS functions**

Find `async function mfRunAutoCycle(){` in the `<script>` block (currently around line 1329) and add these two new functions immediately after `mfRunAutoCycle`'s closing `}`:

```javascript
async function cfoRunForecast() {
  const out = $("cfoForecastOut");
  out.innerHTML = "Running…";
  try {
    const cashOnHand = Number($("cfoCash").value);
    const monthlyExpenses = Number($("cfoExpenses").value);
    const revenueRaw = $("cfoRevenue").value;
    const body = { cashOnHand, monthlyExpenses };
    if (revenueRaw !== "") body.monthlyRevenue = Number(revenueRaw);
    const r = await api("/api/cfo/forecast", "POST", body);
    let html = "<div class='row'><b>Net monthly:</b> $" + r.netMonthly + "</div>";
    html += "<div class='row'><b>Runway:</b> " + (r.runwayMonths === null ? "cash-flow positive" : r.runwayMonths + " months") + "</div>";
    html += "<div class='row'><b>Verdict:</b> " + r.verdict + "</div>";
    html += "<div class='row'><b>6-month projection:</b> " + r.sixMonthProjection.join(", ") + "</div>";
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = "<div class='err'>" + e.message + "</div>";
  }
}
async function cfoCalcRoi() {
  const out = $("cfoRoiOut");
  out.innerHTML = "Calculating…";
  try {
    const cost = Number($("cfoCost").value);
    const expectedReturn = Number($("cfoReturn").value);
    const r = await api("/api/cfo/roi", "POST", { cost, expectedReturn });
    out.innerHTML = "<div class='row'><b>ROI:</b> " + (r.roi * 100).toFixed(1) + "%</div>";
  } catch (e) {
    out.innerHTML = "<div class='err'>" + e.message + "</div>";
  }
}
```

Note: these use plain string concatenation (`+`), not nested template literals — the file's established convention requires escaping backticks and `${` inside the outer `PAGE` template literal, and string concatenation sidesteps that risk entirely (see the escaping bug fixed earlier this session in the Gig Finder tab).

- [ ] **Step 4: Verify the page script still parses**

Run: `pnpm --filter @atlas/server test -- page-script.test.ts`
Expected: PASS — confirms the new HTML/JS didn't break the outer template literal.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/html.ts
git commit -m "feat(server): add CFO tab with forecast and ROI calculator"
```

---

### Task 4: Advisors tab UI

**Files:**
- Modify: `packages/server/src/html.ts` (nav button, tab-array entry, new `<section>` after `tab-cfo`, new JS functions)
- Test: `packages/server/test/page-script.test.ts` (existing test, must keep passing)

- [ ] **Step 1: Add the nav button and tab-array entry**

Change the nav button line added in Task 3 from:

```html
      <button data-tab="cfo">💰 CFO</button>
```

to:

```html
      <button data-tab="cfo">💰 CFO</button>
      <button data-tab="advisors">🏺 Advisors</button>
```

Change the tab array from Task 3's version to add `"advisors"`:

```javascript
["chat","map","businesses","learn","connect","grow","vault","keys","run","brief","actions","proposals","approvals","media-factory","gigs","kdp","cfo","advisors"].forEach(t => { const el=$("tab-"+t); if(el) el.classList.toggle("hide", t!==b.dataset.tab); });
```

- [ ] **Step 2: Add the Advisors section**

Insert this immediately after the `tab-cfo` section's closing `</section>` (added in Task 3):

```html
    <section id="tab-advisors" class="card hide">
      <h2>🏺 Advisors</h2>
      <p class="note" style="margin-bottom:14px">Ask ATLAS's advisor tools for a read on something — both pull from what ATLAS already knows, nothing is automatic.</p>

      <h3>Knowledge Playbook</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div><label>Topic</label><input id="advTopic" style="width:220px" placeholder="e.g. cold outreach, KDP pricing" /></div>
        <div><label>Limit (optional)</label><input id="advLimit" type="number" style="width:100px" placeholder="20" /></div>
        <button onclick="advGetPlaybook()">Get Playbook</button>
      </div>
      <div id="advPlaybookOut"></div>

      <h3 style="margin-top:20px">Archaeologist</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div><label>Topic (optional)</label><input id="digTopic" style="width:220px" placeholder="leave blank for anything" /></div>
        <button onclick="advDig()">Dig Up Old Notes</button>
      </div>
      <div id="advDigOut"></div>
    </section>
```

- [ ] **Step 3: Add the Advisors JS functions**

Add these immediately after the `cfoCalcRoi` function added in Task 3:

```javascript
async function advGetPlaybook() {
  const out = $("advPlaybookOut");
  const topic = $("advTopic").value;
  if (!topic) { out.innerHTML = "<div class='err'>Enter a topic first.</div>"; return; }
  out.innerHTML = "Loading…";
  try {
    const limitRaw = $("advLimit").value;
    const body = { topic };
    if (limitRaw !== "") body.limit = Number(limitRaw);
    const r = await api("/api/knowledge/playbook", "POST", body);
    if (!r.sections.length) { out.innerHTML = "<div class='note'>No lessons filed under this topic yet.</div>"; return; }
    let html = "<h4>" + r.title + "</h4>";
    for (const s of r.sections) {
      html += "<div style='margin-top:8px'><b>" + s.heading + "</b><ul>";
      for (const p of s.points) html += "<li>" + p + "</li>";
      html += "</ul></div>";
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = "<div class='err'>" + e.message + "</div>";
  }
}
async function advDig() {
  const out = $("advDigOut");
  out.innerHTML = "Digging…";
  try {
    const topic = $("digTopic").value;
    const r = await api("/api/archaeologist/dig", "POST", topic ? { topic } : {});
    out.innerHTML = "<div style='white-space:pre-wrap'>" + r.findings + "</div>";
  } catch (e) {
    out.innerHTML = "<div class='err'>" + e.message + "</div>";
  }
}
```

- [ ] **Step 4: Verify the page script still parses**

Run: `pnpm --filter @atlas/server test -- page-script.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/html.ts
git commit -m "feat(server): add Advisors tab with knowledge playbook and archaeologist dig"
```

---

### Task 5: Full verification + deploy

**Files:** none new — this task runs the full suite and deploys.

- [ ] **Step 1: Run the full workspace test suite**

Run: `pnpm test`
Expected: all tests pass (no regressions in any package).

- [ ] **Step 2: Run the full workspace typecheck**

Run: `pnpm typecheck`
Expected: no type errors.

- [ ] **Step 3: Push and deploy**

```bash
git push origin main
```

Then deploy `packages/server/src/server.ts` and `packages/server/src/html.ts` to the VPS following the established deploy pattern:

```bash
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts packages/server/src/html.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 10 && curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/health"
```

Expected: `200`.

- [ ] **Step 4: Spot-check on the live VPS**

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker logs atlas --tail 30"
```

Confirm no new errors on boot. This step is a manual spot-check, not an automated test — the routes themselves are already covered by Tasks 1-2's automated tests.
