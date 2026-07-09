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
      <button data-tab="chat" class="active">💬 Chat</button>
      <button data-tab="learn">🎓 Learn</button>
      <button data-tab="status">Status</button>
      <button data-tab="keys">API Keys</button>
      <button data-tab="logins">Platform Logins</button>
      <button data-tab="run">Run</button>
      <button data-tab="approvals">Approvals</button>
      <button id="lockNow" class="sec" style="margin-left:auto">Lock</button>
    </nav>

    <section id="tab-chat" class="card">
      <h2>Talk to ATLAS</h2>
      <div id="chatBox" style="max-height:420px;overflow-y:auto;padding:6px 2px;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <input id="chatIn" placeholder="Ask ATLAS anything — strategy, content, its own status…" style="flex:1" />
        <button id="chatSend" style="margin-top:0">Send</button>
      </div>
      <div class="note" id="chatMeta">Free models via your keys — the Brain auto-switches providers if one hits a limit. Every chat is saved to ATLAS's memory, so talking to it literally trains it.</div>
    </section>

    <section id="tab-learn" class="card hide">
      <h2>Teach ATLAS the web</h2>
      <label>Learn from a website (read-only — it just reads &amp; takes notes)</label>
      <div style="display:flex;gap:8px;"><input id="learnUrl" placeholder="https://a-site-to-study.com" style="flex:1" /><button style="margin-top:0" onclick="learnUrl()">Learn</button></div>
      <label style="margin-top:14px">Analyze a GitHub repo (owner/name)</label>
      <div style="display:flex;gap:8px;"><input id="repoName" placeholder="pollinations/pollinations" style="flex:1" /><button style="margin-top:0" onclick="learnRepo()">Analyze</button></div>
      <pre id="learnOut" class="hide"></pre>

      <h2 style="margin-top:22px">Your businesses</h2>
      <div id="bizList" class="note">Loading…</div>
      <label style="margin-top:10px">Add a business</label>
      <input id="bizName" placeholder="Business name" />
      <input id="bizUrl" placeholder="https://its-website.com (so ATLAS can study it)" style="margin-top:6px" />
      <input id="bizGoal" placeholder="Goal, e.g. grow to $5k/mo" style="margin-top:6px" />
      <button onclick="addBiz()">Add business</button>
      <div class="note">ATLAS studies one business site each night automatically and files notes to memory. Signing up / posting / installing stays behind your approval.</div>
    </section>

    <section id="tab-status" class="card hide">
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
    bubble("bot", "ATLAS online. Ask me anything — business strategy, content ideas, or what I've been working on. Everything we discuss becomes part of my memory.");
    $("chatIn").focus();
  } catch (e) { $("lockErr").textContent = e.message; }
};
$("lockNow").onclick = async () => { try{ await api("/api/lock","POST"); }catch{} TOKEN=null; location.reload(); };

document.querySelectorAll("nav button[data-tab]").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button[data-tab]").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  ["chat","learn","status","keys","logins","run","approvals"].forEach(t => $("tab-"+t).classList.toggle("hide", t!==b.dataset.tab));
  if (b.dataset.tab==="approvals") loadApprovals();
  if (b.dataset.tab==="chat") $("chatIn").focus();
  if (b.dataset.tab==="learn") loadBiz();
});

// ── Learn ──
async function learnUrl(){ const url=$("learnUrl").value.trim(); if(!url) return; $("learnOut").classList.remove("hide"); $("learnOut").textContent="Reading "+url+" …";
  try { const r = await api("/api/learn","POST",{url}); $("learnOut").textContent = "📄 "+(r.title||url)+"\\n\\n"+r.notes; } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }
async function learnRepo(){ const repo=$("repoName").value.trim(); if(!repo) return; $("learnOut").classList.remove("hide"); $("learnOut").textContent="Analyzing "+repo+" …";
  try { const r = await api("/api/repo","POST",{repo}); $("learnOut").textContent = "📦 "+repo+"\\n\\n"+r.notes; } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }
async function loadBiz(){ try { const r = await api("/api/businesses"); const list = r.businesses||[];
  $("bizList").innerHTML = list.length ? list.map(b => "<div class='row'><span><b>"+b.name+"</b> — "+(b.stage||"idea")+(b.url?" · "+b.url:"")+"</span>"+(b.url?"<button class='mini' onclick=\\"researchBiz('"+b.id+"')\\">study now</button>":"")+"</div>").join("") : "<div class='note'>No businesses yet. Add your first below.</div>";
  } catch(e){ $("bizList").textContent=e.message; } }
async function addBiz(){ try { await api("/api/businesses","POST",{name:$("bizName").value,url:$("bizUrl").value,goal:$("bizGoal").value}); ["bizName","bizUrl","bizGoal"].forEach(i=>$(i).value=""); loadBiz(); } catch(e){ alert(e.message);} }
async function researchBiz(id){ $("learnOut").classList.remove("hide"); $("learnOut").textContent="Studying…";
  try { const r = await api("/api/businesses/"+encodeURIComponent(id)+"/research","POST"); $("learnOut").textContent = r.notes ? ("🏢 "+r.business.name+"\\n\\n"+r.notes) : ("Skipped: "+(r.skipped||"")); loadBiz(); } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }

// ── Chat ──
const chatHistory = [];
function bubble(role, text){
  const d = document.createElement("div");
  d.style.cssText = "margin:8px 0;padding:10px 14px;border-radius:12px;max-width:85%;white-space:pre-wrap;font-size:14px;line-height:1.5;" +
    (role==="user" ? "background:var(--acc);color:#fff;margin-left:auto;" : "background:#12111f;border:1px solid #2a2840;");
  d.textContent = text;
  $("chatBox").appendChild(d);
  $("chatBox").scrollTop = $("chatBox").scrollHeight;
  return d;
}
async function sendChat(){
  const msg = $("chatIn").value.trim();
  if (!msg) return;
  $("chatIn").value = "";
  bubble("user", msg);
  const thinking = bubble("bot", "…thinking");
  try {
    const r = await api("/api/chat","POST",{ message: msg, history: chatHistory });
    thinking.textContent = r.reply;
    chatHistory.push({role:"user",text:msg},{role:"bot",text:r.reply});
    $("chatMeta").textContent = "Answered by "+r.provider+" ("+r.model+") in "+(r.latencyMs/1000).toFixed(1)+"s · saved to memory";
  } catch(e){ thinking.textContent = "⚠ " + e.message; }
}
$("chatSend").onclick = sendChat;
$("chatIn").addEventListener("keydown", (e) => { if (e.key==="Enter") sendChat(); });

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
