/** The single-page control panel. Vanilla JS + fetch — no build step. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ATLAS Control Panel</title>
<style>
  :root { --bg:#0f0e17; --card:#1b1a2b; --ink:#e6e6f0; --mut:#9a97b8; --acc:#7c3aed; --ok:#22c55e; --warn:#f59e0b; --bad:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:18px 24px; border-bottom:1px solid #2a2840; display:flex; align-items:center; gap:12px; }
  header h1 { font-size:18px; margin:0; } header .tag { color:var(--mut); font-size:13px; }
  main { max-width:820px; margin:0 auto; padding:24px; }
  .card { background:var(--card); border:1px solid #2a2840; border-radius:12px; padding:20px; margin-bottom:18px; }
  h2 { font-size:15px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:var(--mut); margin:10px 0 4px; }
  input, textarea, select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #34324f; background:#12111f; color:var(--ink); font-size:14px; }
  button { background:var(--acc); color:#fff; border:0; padding:10px 16px; border-radius:8px; font-size:14px; cursor:pointer; margin-top:12px; }
  button.sec { background:#2a2840; }
  button.mini { padding:6px 10px; font-size:12px; margin:0; }
  nav { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:18px; }
  nav button { background:#2a2840; margin:0; }
  nav button.active { background:var(--acc); }
  .row { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #26243c; }
  .pill { font-size:12px; padding:2px 8px; border-radius:999px; }
  .on { background:rgba(34,197,94,.15); color:var(--ok); } .off { background:rgba(154,151,184,.15); color:var(--mut); }
  .hide { display:none; }
  pre { background:#12111f; padding:14px; border-radius:8px; overflow:auto; font-size:12px; color:#c9c7e0; }
  .note { font-size:12px; color:var(--mut); margin-top:8px; line-height:1.5; }
  .err { color:var(--bad); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<header><h1>🛰️ ATLAS</h1><span class="tag">Control Panel · localhost only</span></header>
<main>

  <div id="lock" class="card">
    <h2 id="lockTitle">Unlock</h2>
    <label>Master password</label>
    <input id="pw" type="password" placeholder="your master password" />
    <button id="lockBtn">Unlock</button>
    <div id="lockErr" class="err"></div>
    <div class="note" id="lockNote"></div>
  </div>

  <div id="app" class="hide">
    <nav>
      <button data-tab="status" class="active">Status</button>
      <button data-tab="keys">API Keys</button>
      <button data-tab="logins">Platform Logins</button>
      <button data-tab="run">Run</button>
      <button data-tab="approvals">Approvals</button>
      <button id="lockNow" class="sec" style="margin-left:auto">Lock</button>
    </nav>

    <section id="tab-status" class="card">
      <h2>Readiness</h2><div id="statusBox">Loading…</div>
      <button class="sec" onclick="loadStatus()">Refresh</button>
    </section>

    <section id="tab-keys" class="card hide">
      <h2>AI API keys</h2>
      <div id="providers"></div>
      <label>Key name</label>
      <select id="keyName">
        <option>GROQ_API_KEY</option><option>GEMINI_API_KEY</option>
        <option>OPENROUTER_API_KEY</option><option>ANTHROPIC_API_KEY</option>
      </select>
      <label>Key value</label>
      <input id="keyVal" type="password" placeholder="paste the key" />
      <button onclick="saveKey()">Save key (encrypted)</button>
      <button class="sec" onclick="exportEnv()">🌙 Enable overnight runs (copy keys to this computer)</button>
      <div class="note">Keys are encrypted with your master password and used to power the Brain. Grab free ones: console.groq.com · aistudio.google.com · openrouter.ai<br/><br/>🌙 "Enable overnight runs" copies your keys into a local file so ATLAS can work at night without your password. That file stays on this computer only and is never uploaded — but it is not encrypted, so only do this on your own laptop.</div>
    </section>

    <section id="tab-logins" class="card hide">
      <h2>Platform logins</h2>
      <div id="creds"></div>
      <label>Platform</label>
      <input id="cPlat" placeholder="instagram" />
      <label>Username / email</label>
      <input id="cUser" placeholder="you@example.com" />
      <label>Password</label>
      <input id="cPass" type="password" placeholder="stored encrypted" />
      <label>Notes (optional)</label>
      <input id="cNote" placeholder="2FA backup codes, etc." />
      <button onclick="saveCred()">Save login (encrypted)</button>
      <div class="note">⚠️ Stored encrypted, locally, never uploaded. Note: some platforms (e.g. Instagram) may flag automated password logins — we may later switch to a saved login session for safety. ATLAS never posts without your approval.</div>
    </section>

    <section id="tab-run" class="card hide">
      <h2>Run one autonomous day</h2>
      <button onclick="runCycle()">▶ Run daily cycle (posts nothing)</button>
      <pre id="report" class="hide"></pre>
    </section>

    <section id="tab-approvals" class="card hide">
      <h2>Awaiting your approval</h2>
      <div id="approvals">None loaded.</div>
      <button class="sec" onclick="loadApprovals()">Refresh</button>
    </section>
  </div>
</main>

<script>
let TOKEN = null;
const $ = (id) => document.getElementById(id);
async function api(path, method="GET", body) {
  const r = await fetch(path, { method, headers: { "Content-Type":"application/json", ...(TOKEN?{"x-atlas-token":TOKEN}:{}) }, body: body?JSON.stringify(body):undefined });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || ("HTTP "+r.status));
  return data;
}
async function boot() {
  const h = await api("/api/health");
  $("lockTitle").textContent = h.initialized ? "Unlock" : "Create your vault";
  $("lockBtn").textContent = h.initialized ? "Unlock" : "Create vault";
  $("lockNote").textContent = h.initialized ? "Enter your master password to unlock ATLAS's secrets." : "Pick a strong master password (8+ chars). It encrypts everything and cannot be recovered — don't lose it.";
}
$("lockBtn").onclick = async () => {
  $("lockErr").textContent = "";
  const pw = $("pw").value;
  try {
    const h = await api("/api/health");
    const res = await api(h.initialized ? "/api/unlock" : "/api/setup", "POST", { masterPassword: pw });
    TOKEN = res.token;
    $("lock").classList.add("hide"); $("app").classList.remove("hide");
    loadStatus(); loadProviders(); loadCreds();
  } catch (e) { $("lockErr").textContent = e.message; }
};
$("lockNow").onclick = async () => { try{ await api("/api/lock","POST"); }catch{} TOKEN=null; location.reload(); };

document.querySelectorAll("nav button[data-tab]").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button[data-tab]").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  ["status","keys","logins","run","approvals"].forEach(t => $("tab-"+t).classList.toggle("hide", t!==b.dataset.tab));
  if (b.dataset.tab==="approvals") loadApprovals();
});

async function loadStatus() {
  try { const s = await api("/api/status");
    $("statusBox").innerHTML =
      row("Plugins active", s.pluginCount) + row("Brain", s.brainMode) +
      row("Publisher", s.publisher) + row("Platform logins stored", s.credentials) +
      "<div class='note'>To go live: " + s.checklist.filter(c=>!c.done).map(c=>c.item).join(" · ") + "</div>";
  } catch(e){ $("statusBox").textContent = e.message; }
}
async function loadProviders() {
  const s = await api("/api/secrets");
  $("providers").innerHTML = Object.entries(s.providers).map(([k,v]) =>
    "<div class='row'><span>"+k+"</span><span class='pill "+(v?"on":"off")+"'>"+(v?"set":"missing")+"</span></div>").join("");
}
async function saveKey(){ try { await api("/api/secrets","POST",{name:$("keyName").value, value:$("keyVal").value}); $("keyVal").value=""; loadProviders(); loadStatus(); } catch(e){ alert(e.message);} }
async function exportEnv(){ try { const r = await api("/api/export-env","POST"); alert("Done — "+r.exported+" key(s) enabled for overnight runs on this computer."); } catch(e){ alert(e.message);} }
async function loadCreds(){ const c = await api("/api/credentials");
  $("creds").innerHTML = (c.credentials.length? c.credentials : []).map(x =>
    "<div class='row'><span><b>"+x.platform+"</b> — "+x.username+"</span><button class='mini sec' onclick=\\"delCred('"+x.platform+"')\\">remove</button></div>").join("") || "<div class='note'>No logins saved yet.</div>";
}
async function saveCred(){ try{ await api("/api/credentials","POST",{platform:$("cPlat").value,username:$("cUser").value,password:$("cPass").value,notes:$("cNote").value}); ["cPlat","cUser","cPass","cNote"].forEach(i=>$(i).value=""); loadCreds(); loadStatus(); }catch(e){ alert(e.message);} }
async function delCred(p){ await api("/api/credentials/"+encodeURIComponent(p),"DELETE"); loadCreds(); loadStatus(); }
async function runCycle(){ $("report").classList.remove("hide"); $("report").textContent="Running…";
  try { const r = await api("/api/cycle","POST");
    $("report").textContent =
      "Topic: "+r.topic+"\\nHook: "+r.reel.hook+"\\nCouncil: "+(r.council?r.council.consensus+" — "+r.council.recommendation:"n/a")+
      "\\nPublish: "+r.publish.status+"\\nCompliance flags: "+(r.compliance?.length||0)+"\\nAwaiting approval: "+(r.pendingApprovals?.length||0);
  } catch(e){ $("report").textContent = e.message; } loadApprovals(); }
async function loadApprovals(){ try { const a = await api("/api/approvals");
  $("approvals").innerHTML = (a.pending?.length? a.pending: []).map(x =>
    "<div class='row'><span>"+x.action+"</span><span><button class='mini' onclick=\\"decide('"+x.id+"','approve')\\">approve</button> <button class='mini sec' onclick=\\"decide('"+x.id+"','reject')\\">reject</button></span></div>").join("") || "<div class='note'>Nothing waiting. 🎉</div>";
  } catch(e){ $("approvals").textContent = e.message; } }
async function decide(id, action){ await api("/api/approvals/"+encodeURIComponent(id)+"/"+action,"POST"); loadApprovals(); }
function row(k,v){ return "<div class='row'><span>"+k+"</span><b>"+v+"</b></div>"; }
boot();
</script>
</body>
</html>`;
