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
  @keyframes flow { to { stroke-dashoffset: 0; } }
  #mapSvg .node text { transition: opacity .15s; }
  #mapSvg.focus .nerve:not(.hot), #mapSvg.focus .sig:not(.hot) { stroke-opacity:.05; }
  #mapSvg .nerve.hot { stroke-opacity:.9 !important; stroke-width:1.6; }
  #mapSvg .sig.hot { stroke-opacity:1 !important; stroke-width:3; }
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
      <button data-tab="map">🧠 Map</button>
      <button data-tab="learn">🎓 Learn</button>
      <button data-tab="connect">🔌 Connect</button>
      <button data-tab="vault">🧰 Vault</button>
      <button data-tab="status">Status</button>
      <button data-tab="keys">API Keys</button>
      <button data-tab="logins">Platform Logins</button>
      <button data-tab="run">Run</button>
      <button data-tab="actions">⚡ Actions</button>
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

    <section id="tab-map" class="card hide">
      <h2>ATLAS · living map</h2>
      <div class="note">The orchestrator (center) fires signals down its nerves to every agent, and agents reach out to your businesses. Hover a node to light its connections; click an agent to ask ATLAS about it.</div>
      <div id="mapWrap" style="position:relative;margin-top:10px;"><svg id="mapSvg" viewBox="0 0 1000 720" style="width:100%;height:auto;display:block;"></svg></div>
      <div id="mapInfo" class="note" style="text-align:center;min-height:18px;"></div>
      <div id="mapLegend" style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;font-size:12px;color:var(--mut);margin-top:6px;"></div>
    </section>

    <section id="tab-connect" class="card hide">
      <h2>Connect your accounts (read-only)</h2>
      <div class="note">Paste an access token for each service. Stored encrypted in your vault. ATLAS can then SEE your repos / deploys / databases and learn them. It cannot change or deploy anything without your approval.</div>
      <div id="connStatus" style="margin-top:10px"></div>
      <label style="margin-top:12px">GitHub token <span class="note">(github.com → Settings → Developer settings → Personal access tokens; read-only scopes)</span></label>
      <div style="display:flex;gap:8px;"><input id="ghTok" type="password" placeholder="ghp_…" style="flex:1"/><button style="margin-top:0" onclick="saveTok('GITHUB_TOKEN','ghTok')">Save</button><button class="sec" style="margin-top:0" onclick="syncConn('github')">Sync</button></div>
      <label style="margin-top:10px">Vercel token</label>
      <div style="display:flex;gap:8px;"><input id="vcTok" type="password" placeholder="vercel token" style="flex:1"/><button style="margin-top:0" onclick="saveTok('VERCEL_TOKEN','vcTok')">Save</button><button class="sec" style="margin-top:0" onclick="syncConn('vercel')">Sync</button></div>
      <label style="margin-top:10px">Supabase access token</label>
      <div style="display:flex;gap:8px;"><input id="sbTok" type="password" placeholder="sbp_…" style="flex:1"/><button style="margin-top:0" onclick="saveTok('SUPABASE_TOKEN','sbTok')">Save</button><button class="sec" style="margin-top:0" onclick="syncConn('supabase')">Sync</button></div>
      <pre id="connOut" class="hide"></pre>

      <h2 style="margin-top:22px">📨 Message ATLAS from the road</h2>
      <div class="note">On your phone, open the GitHub app → the <b>atlas</b> repo → Issues → New issue. Type your instruction as the title. ATLAS reads open issues (here, or automatically on its cloud cycle) and adds them to what it's working on.</div>
      <div style="display:flex;gap:8px;margin-top:8px;"><input id="inboxRepo" placeholder="EvervibesDigital/atlas" style="flex:1"/><button style="margin-top:0" onclick="checkInbox()">Check inbox</button></div>
      <pre id="inboxOut" class="hide"></pre>
    </section>

    <section id="tab-vault" class="card hide">
      <h2>Internal AI Vault</h2>
      <div class="note">ATLAS's memory of tools &amp; sites. For any job it uses the <b>best-quality</b> option that's <b>free</b> or that you've <b>approved</b> to pay for — never a paid tool on its own.</div>
      <div id="toolList" class="note" style="margin-top:10px">Loading…</div>
      <label style="margin-top:12px">Add a tool / site</label>
      <input id="tName" placeholder="Name, e.g. Pollinations" />
      <div style="display:flex;gap:8px;margin-top:6px"><input id="tCat" placeholder="category (images, tts, video, posting…)" style="flex:1" /><input id="tQual" type="number" min="1" max="5" value="4" title="quality 1-5" style="width:90px" /></div>
      <input id="tUrl" placeholder="https://… (optional)" style="margin-top:6px" />
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;"><input id="tFree" type="checkbox" checked style="width:auto" /> Free to use</label>
      <button onclick="addTool()">Add to vault</button>
      <div style="margin-top:14px"><input id="tBestCat" placeholder="best tool for… (category)" style="width:60%;display:inline-block" /> <button class="sec" style="margin-top:0" onclick="bestTool()">Find best</button> <span id="bestOut" class="note"></span></div>
    </section>

    <section id="tab-learn" class="card hide">
      <h2>Teach ATLAS the web</h2>
      <label>Learn from a website (read-only — it just reads &amp; takes notes)</label>
      <div style="display:flex;gap:8px;"><input id="learnUrl" placeholder="https://a-site-to-study.com" style="flex:1" /><button style="margin-top:0" onclick="learnUrl()">Learn</button></div>
      <label style="margin-top:14px">Analyze a GitHub repo (owner/name)</label>
      <div style="display:flex;gap:8px;"><input id="repoName" placeholder="pollinations/pollinations" style="flex:1" /><button style="margin-top:0" onclick="learnRepo()">Analyze</button></div>
      <pre id="learnOut" class="hide"></pre>

      <label style="margin-top:14px">Study a codebase you've built (folder path — read-only, changes nothing)</label>
      <div style="display:flex;gap:8px;"><input id="cbDir" placeholder="C:\\Users\\matbr\\claudecode1" style="flex:1" /><button style="margin-top:0" onclick="learnCodebase()">Study</button></div>
      <div class="note">Point it at your evervibes / wholesale folder. ATLAS reads the structure, configs, and workflows and writes an understanding to memory. It will not edit anything.</div>

      <label style="margin-top:14px">Import our Claude chat history (folder with .jsonl transcripts)</label>
      <div style="display:flex;gap:8px;"><input id="histDir" placeholder="C:\\Users\\matbr\\.claude\\projects\\C--Users-matbr-claudecode1" style="flex:1" /><button style="margin-top:0" onclick="importHistory()">Import</button></div>
      <div class="note">Reads the local Claude Code transcripts of everything we've built and files them into ATLAS's memory.</div>

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

    <section id="tab-actions" class="card hide">
      <h2>Real-world actions</h2>
      <div class="note">ATLAS can request actions (sign up for a site, install a repo, post). Each one goes to your <b>Approvals</b> tab first. Until you enable the real browser driver, approving an action <b>simulates</b> it — it logs what it would do and touches nothing.</div>
      <label style="margin-top:12px">Ask ATLAS to prepare an action</label>
      <select id="actType"><option value="signup">Sign up for a site</option><option value="install">Install a GitHub repo</option><option value="post">Post something</option><option value="browse">Browse & do a task</option></select>
      <input id="actTitle" placeholder="Short title, e.g. Sign up for Buffer" style="margin-top:6px" />
      <input id="actTarget" placeholder="URL or owner/repo" style="margin-top:6px" />
      <button onclick="requestAction()">Prepare action (goes to Approvals)</button>
      <h2 style="margin-top:20px">Action history</h2>
      <div id="actList" class="note">None yet.</div>
      <button class="sec" onclick="loadActions()">Refresh</button>
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
  ["chat","map","learn","connect","vault","status","keys","logins","run","actions","approvals"].forEach(t => $("tab-"+t).classList.toggle("hide", t!==b.dataset.tab));
  if (b.dataset.tab==="approvals") loadApprovals();
  if (b.dataset.tab==="chat") $("chatIn").focus();
  if (b.dataset.tab==="learn") loadBiz();
  if (b.dataset.tab==="actions") loadActions();
  if (b.dataset.tab==="vault") loadTools();
  if (b.dataset.tab==="map") renderMap();
});

// ── Connectors + inbox + history ──
async function saveTok(name, inputId){ const v=$(inputId).value.trim(); if(!v) return; try { await api("/api/secrets","POST",{name,value:v}); $(inputId).value=""; alert(name+" saved (encrypted)."); } catch(e){ alert(e.message);} }
async function syncConn(which){ $("connOut").classList.remove("hide"); $("connOut").textContent="Syncing "+which+" …";
  try { const r=await api("/api/connectors/"+which+"/sync","POST"); $("connOut").textContent="✅ "+r.summary+"\\n\\n"+(r.items||[]).slice(0,40).join("\\n"); } catch(e){ $("connOut").textContent="⚠ "+e.message; } }
async function checkInbox(){ const repo=$("inboxRepo").value.trim()||"EvervibesDigital/atlas"; $("inboxOut").classList.remove("hide"); $("inboxOut").textContent="Checking "+repo+" …";
  try { const r=await api("/api/inbox/check","POST",{repo}); $("inboxOut").textContent = r.new && r.new.length ? ("📨 "+r.new.length+" new instruction(s) added to memory:\\n"+r.new.map(m=>"#"+m.number+" "+m.title).join("\\n")) : ("No new messages ("+r.total+" open issues seen)."); } catch(e){ $("inboxOut").textContent="⚠ "+e.message; } }
async function importHistory(){ const dir=$("histDir").value.trim(); if(!dir) return; $("learnOut").classList.remove("hide"); $("learnOut").textContent="Importing chat history from "+dir+" …";
  try { const r=await api("/api/import-history","POST",{dir}); $("learnOut").textContent="🧠 Imported "+r.imported+" chat log(s) into memory:\\n"+(r.files||[]).join("\\n"); } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }

// ── Codebase learning ──
async function learnCodebase(){ const dir=$("cbDir").value.trim(); if(!dir) return; $("learnOut").classList.remove("hide"); $("learnOut").textContent="Studying "+dir+" … (large codebases take a moment)";
  try { const r = await api("/api/codebase","POST",{dir}); $("learnOut").textContent = "💾 "+r.scan.name+" ("+r.scan.fileCount+" files, "+(r.scan.workflows.length)+" workflows)\\n\\n"+r.notes; } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }

// ── AI Vault ──
async function loadTools(){ try { const r=await api("/api/tools"); const list=r.tools||[];
  $("toolList").innerHTML = list.length ? list.map(t => "<div class='row'><span><b>"+t.name+"</b> · "+t.category+" · ⭐"+t.quality+" <span class='pill "+((t.free||t.approved)?"on":"off")+"'>"+(t.free?"free":(t.approved?"approved":"needs approval"))+"</span></span>"+(!t.free&&!t.approved?"<button class='mini' onclick=\\"approveTool('"+t.id+"')\\">approve $</button>":"")+"</div>").join("") : "<div class='note'>Vault is empty. Add your gathered tools &amp; sites below.</div>";
  } catch(e){ $("toolList").textContent=e.message; } }
async function addTool(){ try { await api("/api/tools","POST",{name:$("tName").value,category:$("tCat").value,url:$("tUrl").value,quality:$("tQual").value,free:$("tFree").checked}); ["tName","tCat","tUrl"].forEach(i=>$(i).value=""); loadTools(); } catch(e){ alert(e.message);} }
async function approveTool(id){ await api("/api/tools/"+encodeURIComponent(id)+"/approve","POST"); loadTools(); }
async function bestTool(){ const c=$("tBestCat").value.trim(); if(!c) return; try { const r=await api("/api/tools"); const list=(r.tools||[]).filter(t=>t.category.toLowerCase()===c.toLowerCase() && (t.free||t.approved)).sort((a,b)=>b.quality-a.quality); $("bestOut").textContent = list.length? ("→ "+list[0].name+" (⭐"+list[0].quality+")") : "→ nothing usable yet"; } catch(e){ $("bestOut").textContent=e.message; } }

// ── Neural map ──
const MAP_GROUPS = { core:["brain","memory","executive","approvals","guardian","backup"], create:["creative","publishing","personas","web"], intel:["research","opportunity","strategy","analytics","detective","simulation","knowledge","experiments","codebase"], money:["cfo","negotiation","business","toolvault"], ops:["learning","automation","techdebt","engineering","compliance","actions"] };
const MAP_COLORS = { core:"#a78bfa", create:"#f472b6", intel:"#38bdf8", money:"#fbbf24", ops:"#34d399", biz:"#e5e7eb", other:"#94a3b8" };
function groupOf(name){ for(const g in MAP_GROUPS){ if(MAP_GROUPS[g].includes(name)) return g; } return "other"; }
const SVGNS="http://www.w3.org/2000/svg";
function el(tag, attrs){ const e=document.createElementNS(SVGNS,tag); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }
let mapDone=false;
async function renderMap(){ if(mapDone) return; mapDone=true;
  const svg=$("mapSvg"); svg.innerHTML="";
  let data; try { data = await api("/api/map"); } catch(e){ mapDone=false; return; }
  const agents = (data.agents||[]).filter(a=>a!=="orchestrator" && a!=="hello");
  const businesses = data.businesses||[];
  const cx=500, cy=350, aR=210, bR=322;
  const links=[]; const nodeEls={};
  // agent positions
  const A = agents.map((name,i)=>{ const ang=(i/agents.length)*2*Math.PI - Math.PI/2; return {name, group:groupOf(name), x:cx+aR*Math.cos(ang), y:cy+aR*Math.sin(ang), ang}; });
  // business positions
  const B = businesses.map((name,i)=>{ const ang=(i/Math.max(1,businesses.length))*2*Math.PI - Math.PI/2; return {name, x:cx+bR*Math.cos(ang), y:cy+bR*Math.sin(ang), ang}; });
  function curve(x1,y1,x2,y2){ const mx=(x1+x2)/2, my=(y1+y2)/2; const dx=x2-x1, dy=y2-y1; const nx=-dy, ny=dx; const k=0.12; return "M"+x1+" "+y1+" Q"+(mx+nx*k)+" "+(my+ny*k)+" "+x2+" "+y2; }
  // center glow
  svg.appendChild(el("circle",{cx:cx,cy:cy,r:70,fill:"url(#glow)",opacity:"0.5"}));
  const defs=el("defs",{}); defs.innerHTML='<radialGradient id="glow"><stop offset="0%" stop-color="#7c3aed" stop-opacity="0.7"/><stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>'; svg.appendChild(defs);
  // agent nerves + signals
  A.forEach(a=>{ const d=curve(cx,cy,a.x,a.y); const c=MAP_COLORS[a.group];
    const nerve=el("path",{d:d,fill:"none",stroke:c,"stroke-width":"1","stroke-opacity":"0.28",class:"nerve"});
    const sig=el("path",{d:d,fill:"none",stroke:c,"stroke-width":"2.2","stroke-linecap":"round","stroke-dasharray":"3 460","stroke-dashoffset":"463",class:"sig"}); sig.style.animation="flow "+(2.4+Math.random()*2.6)+"s linear infinite"; sig.style.animationDelay=(-Math.random()*4)+"s";
    svg.appendChild(nerve); svg.appendChild(sig); a._paths=[nerve,sig]; links.push({a:a.name,el:[nerve,sig]}); });
  // business links → 2 nearest agents by angle
  B.forEach(b=>{ const sorted=[...A].sort((p,q)=>Math.abs(angDiff(p.ang,b.ang))-Math.abs(angDiff(q.ang,b.ang))); const near=sorted.slice(0,2); b._paths=[];
    near.forEach(a=>{ const nerve=el("path",{d:curve(a.x,a.y,b.x,b.y),fill:"none",stroke:MAP_COLORS.biz,"stroke-width":"1","stroke-opacity":"0.18",class:"nerve"}); svg.appendChild(nerve); b._paths.push(nerve); a._paths.push(nerve); }); });
  function angDiff(x,y){ let d=x-y; while(d>Math.PI)d-=2*Math.PI; while(d<-Math.PI)d+=2*Math.PI; return d; }
  // nodes
  function addNode(o, r, fill, label, kind){ const g=el("g",{class:"node",style:"cursor:pointer"});
    const c=el("circle",{cx:o.x,cy:o.y,r:r,fill:fill,stroke:"#0f0e17","stroke-width":"1.5"}); c.style.filter="drop-shadow(0 0 5px "+fill+"88)";
    const tx=el("text",{x:o.x,y:o.y-(r+6),"text-anchor":"middle","font-size":"12","fill":"#e6e6f0",opacity:"0",style:"pointer-events:none;font-family:system-ui"}); tx.textContent=label;
    g.appendChild(c); g.appendChild(tx);
    g.addEventListener("mouseenter",()=>{ svg.classList.add("focus"); (o._paths||[]).forEach(p=>p.classList.add("hot")); tx.setAttribute("opacity","1"); $("mapInfo").textContent=(kind==="agent"?"🧩 "+label+" agent":kind==="biz"?"🏢 "+label:"🧠 ATLAS orchestrator"); });
    g.addEventListener("mouseleave",()=>{ svg.classList.remove("focus"); (o._paths||[]).forEach(p=>p.classList.remove("hot")); tx.setAttribute("opacity","0"); $("mapInfo").textContent=""; });
    if(kind==="agent") g.addEventListener("click",()=>{ document.querySelector('nav button[data-tab="chat"]').click(); $("chatIn").value="What does the "+label+" agent do in ATLAS, and how is it doing?"; $("chatIn").focus(); });
    svg.appendChild(g); return c; }
  A.forEach(a=>addNode(a, 7, MAP_COLORS[a.group], a.name, "agent"));
  B.forEach(b=>addNode(b, 8, MAP_COLORS.biz, b.name, "biz"));
  const center={x:cx,y:cy,_paths:A.flatMap(a=>a._paths)}; const cc=addNode(center, 26, "#7c3aed", "ATLAS", "core");
  const ctext=el("text",{x:cx,y:cy+4,"text-anchor":"middle","font-size":"15","font-weight":"800","fill":"#fff",style:"pointer-events:none;font-family:system-ui"}); ctext.textContent="ATLAS"; svg.appendChild(ctext);
  // legend
  $("mapLegend").innerHTML = Object.entries({core:"Core",create:"Creative",intel:"Intelligence",money:"Money",ops:"Ops",biz:"Businesses"}).map(([k,v])=>"<span><span style='display:inline-block;width:10px;height:10px;border-radius:50%;background:"+MAP_COLORS[k]+";margin-right:5px'></span>"+v+"</span>").join("");
}

// ── Actions ──
async function requestAction(){ try { await api("/api/action","POST",{type:$("actType").value,title:$("actTitle").value,target:$("actTarget").value}); $("actTitle").value=""; $("actTarget").value=""; loadActions(); alert("Prepared — approve it in the Approvals tab to run (simulated)."); } catch(e){ alert(e.message);} }
async function loadActions(){ try { const r = await api("/api/actions"); const list=r.actions||[];
  $("actList").innerHTML = list.length ? list.map(a => "<div class='row'><span><b>"+a.request.title+"</b> · <span class='pill "+(a.status==="pending-approval"?"off":"on")+"'>"+a.status+"</span>"+(a.result?"<br/><span class='note'>"+a.result+"</span>":"")+"</span></div>").join("") : "<div class='note'>No actions yet.</div>";
  } catch(e){ $("actList").textContent=e.message; } }

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
