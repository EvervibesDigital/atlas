/** The single-page control panel. Vanilla JS + fetch — no build step. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ATLAS Control Panel</title>
<style>
  :root {
    --bg:#04060d; --bg2:#070b16; --card:rgba(16,22,40,.66); --ink:#e8ecff; --mut:#8894b8;
    --acc:#7c3aed; --acc2:#22d3ee; --line:rgba(124,131,180,.16);
    --ok:#34d399; --warn:#f59e0b; --bad:#f43f5e;
    --mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --glow: 0 0 24px rgba(34,211,238,.28);
  }
  * { box-sizing: border-box; }
  body {
    margin:0; font-family: system-ui, -apple-system, sans-serif; color:var(--ink);
    background:
      radial-gradient(1100px 700px at 78% -8%, rgba(124,58,237,.20), transparent 60%),
      radial-gradient(900px 620px at 12% 108%, rgba(34,211,238,.14), transparent 60%),
      linear-gradient(180deg, var(--bg2), var(--bg));
    background-attachment: fixed; min-height:100vh;
  }
  /* Animated supercomputer grid underlay */
  body::before {
    content:""; position:fixed; inset:-2px; z-index:0; pointer-events:none; opacity:.5;
    background-image:
      linear-gradient(rgba(124,131,180,.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124,131,180,.07) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(circle at 50% 40%, #000 55%, transparent 100%);
    animation: drift 24s linear infinite;
  }
  @keyframes drift { to { background-position: 46px 46px, 46px 46px; } }
  header, main { position:relative; z-index:1; }
  header {
    padding:16px 26px; display:flex; align-items:center; gap:14px;
    border-bottom:1px solid var(--line);
    background:linear-gradient(180deg, rgba(10,14,26,.7), transparent);
    backdrop-filter: blur(10px);
  }
  header h1 {
    font-size:20px; margin:0; letter-spacing:.14em; font-family:var(--mono); font-weight:700;
    background:linear-gradient(92deg,#c4b5fd,#22d3ee 70%); -webkit-background-clip:text;
    background-clip:text; color:transparent; text-shadow:0 0 30px rgba(124,58,237,.4);
  }
  header .tag { color:var(--mut); font-size:12px; font-family:var(--mono); letter-spacing:.04em; }
  .live { display:inline-flex; align-items:center; gap:7px; margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--acc2); letter-spacing:.16em; }
  .live i { width:9px; height:9px; border-radius:50%; background:var(--acc2); box-shadow:0 0 12px var(--acc2); animation:pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{ opacity:1; transform:scale(1);} 50%{ opacity:.35; transform:scale(.7);} }
  main { max-width:900px; margin:0 auto; padding:26px; }
  #tab-chat { max-height:90vh; }
  .card {
    background:var(--card); border:1px solid var(--line); border-radius:16px; padding:22px; margin-bottom:18px;
    backdrop-filter: blur(14px) saturate(1.1);
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 50px -28px rgba(0,0,0,.9);
  }
  h2 { font-size:14px; margin:0 0 14px; font-family:var(--mono); letter-spacing:.06em; text-transform:uppercase; color:#cdd4f5; }
  label { display:block; font-size:12px; color:var(--mut); margin:10px 0 4px; font-family:var(--mono); letter-spacing:.03em; }
  input, textarea, select {
    width:100%; padding:11px 13px; border-radius:10px; border:1px solid rgba(124,131,180,.22);
    background:rgba(4,7,14,.7); color:var(--ink); font-size:14px; transition:border-color .15s, box-shadow .15s;
  }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--acc2); box-shadow:var(--glow); }
  button {
    background:linear-gradient(92deg,var(--acc),#6d28d9); color:#fff; border:0; padding:10px 17px;
    border-radius:10px; font-size:14px; cursor:pointer; margin-top:12px; letter-spacing:.02em;
    transition:transform .12s, box-shadow .2s, filter .2s;
  }
  button:hover { transform:translateY(-1px); box-shadow:0 0 22px rgba(124,58,237,.5); filter:brightness(1.08); }
  button.sec { background:rgba(124,131,180,.12); border:1px solid var(--line); }
  button.sec:hover { box-shadow:0 0 18px rgba(34,211,238,.25); }
  button.mini { padding:6px 10px; font-size:12px; margin:0; }
  nav { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  nav button { background:rgba(124,131,180,.1); border:1px solid var(--line); margin:0; font-family:var(--mono); font-size:12px; letter-spacing:.03em; }
  nav button.active { background:linear-gradient(92deg,var(--acc),var(--acc2)); box-shadow:var(--glow); border-color:transparent; }
  .row { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--line); }
  .pill { font-size:11px; padding:3px 9px; border-radius:999px; font-family:var(--mono); letter-spacing:.04em; }
  .on { background:rgba(52,211,153,.14); color:var(--ok); box-shadow:0 0 12px rgba(52,211,153,.2); } .off { background:rgba(136,148,184,.12); color:var(--mut); }
  .hide { display:none; }
  pre { background:rgba(4,7,14,.8); padding:14px; border-radius:10px; overflow:auto; font-size:12px; color:#bfe9f5; border:1px solid var(--line); }
  .note { font-size:12px; color:var(--mut); margin-top:8px; line-height:1.55; }
  .err { color:var(--bad); font-size:13px; margin-top:8px; }
  @keyframes flow { to { stroke-dashoffset: 0; } }
  #mapSvg .node text { transition: opacity .15s; }
  #mapSvg.focus .nerve:not(.hot), #mapSvg.focus .sig:not(.hot) { stroke-opacity:.05; }
  #mapSvg .nerve.hot { stroke-opacity:.9 !important; stroke-width:1.6; }
  #mapSvg .sig.hot { stroke-opacity:1 !important; stroke-width:3; }
  /* Chat bubbles — terminal glass */
  #chatBox .bub { max-width:82%; padding:11px 14px; border-radius:14px; margin:8px 0; font-size:14px; line-height:1.5; white-space:pre-wrap; word-wrap:break-word; }
  #chatBox .bub.user { margin-left:auto; background:linear-gradient(92deg,rgba(124,58,237,.9),rgba(109,40,217,.85)); border:1px solid rgba(124,58,237,.5); }
  #chatBox .bub.bot { background:rgba(10,16,30,.8); border:1px solid var(--line); box-shadow:0 0 18px -6px rgba(34,211,238,.3); }
  .chatItem { padding:8px 10px; border-radius:9px; font-size:13px; color:var(--mut); cursor:pointer; margin:2px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:6px; }
  .chatItem:hover { background:rgba(124,58,237,.12); color:#fff; }
  .chatItem.active { background:rgba(124,58,237,.22); color:#fff; border:1px solid rgba(124,58,237,.4); }
  .chatItem .del { margin-left:auto; opacity:0; font-size:12px; flex-shrink:0; }
  .chatItem:hover .del { opacity:.6; }
  .chatItem .del:hover { opacity:1; }
  .projGroup { font-size:11px; color:var(--acc); text-transform:uppercase; letter-spacing:.06em; margin:10px 0 3px; padding-left:4px; }
</style>
</head>
<body>
<header><h1>ATLAS</h1><span class="tag">AUTONOMOUS OS · localhost secure</span><span class="live"><i></i>SYSTEM ONLINE</span></header>
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
      <button data-tab="businesses">💼 Businesses</button>
      <button data-tab="learn">🎓 Learn</button>
      <button data-tab="connect">🔌 Connect</button>
      <button data-tab="grow">🔨 Grow</button>
      <button data-tab="vault">🧰 Vault</button>
      <button data-tab="status">Status</button>
      <button data-tab="keys">🔑 Keys & Logins</button>
      <button data-tab="run">⚙️ Run</button>
      <button data-tab="actions">⚡ Actions</button>
      <button data-tab="proposals">💡 Proposals</button>
      <button data-tab="approvals">Approvals</button>
      <button data-tab="media-factory">🎬 Media Factory</button>
      <button id="lockNow" class="sec" style="margin-left:auto">Lock</button>
    </nav>

    <section id="tab-chat" class="card" style="padding:0;overflow:hidden;">
      <div style="display:flex;height:min(74vh,800px);">
        <aside id="chatSide" style="width:236px;flex-shrink:0;border-right:1px solid var(--line);padding:14px 12px;overflow-y:auto;background:rgba(6,10,20,.45);">
          <button id="newChat" style="width:100%;margin:0 0 14px">✚ New Chat</button>
          <div id="projList"></div>
          <div style="font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.09em;margin:16px 0 6px">Recent chats</div>
          <div id="chatList"></div>
          <div style="font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.09em;margin:24px 0 6px">🗑️ Recently Deleted</div>
          <div id="deletedList"></div>
        </aside>
        <div style="flex:1;display:flex;flex-direction:column;padding:16px 18px;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;width:100%">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
              <h2 id="chatTitle" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Talk to ATLAS</h2>
              <button id="renameChatBtn" class="mini sec" style="padding:2px 6px;margin:0;display:none;" title="Rename Chat">✏️ Rename</button>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              <span id="chatProj" class="note" style="margin:0;"></span>
              <button id="moveProjBtn" class="mini sec" style="padding:2px 6px;margin:0;display:none;" title="Move to Project">📁 Project</button>
            </div>
          </div>
          <div id="chatBox" style="flex:1;overflow-y:auto;padding:10px 4px;"></div>
          <div style="display:flex;gap:8px;margin-top:10px;align-items:flex-end;">
            <textarea id="chatIn" rows="3" placeholder="Ask ATLAS anything — or tap the mic to talk…" style="flex:1;resize:vertical;min-height:52px;"></textarea>
            <button id="chatMic" class="sec" style="margin-top:0" title="Speak">🎤</button>
            <button id="chatSend" style="margin-top:0">Send</button>
          </div>
          <div class="note" id="chatMeta">ATLAS picks the best free model you have keys for (Gemini/Groq/HuggingFace) and falls back to your local Llama 3.2 — private and unlimited. Each reply shows which model answered. Every chat is saved to memory.</div>
        </div>
      </div>
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

    <section id="tab-grow" class="card hide">
      <h2>ATLAS grows itself</h2>
      <div class="note">Three ways ATLAS improves itself — all on your free LLMs, no token cost. <b>Self-improve</b> = ATLAS reads its own code + suggests changes (you approve). <b>Skills</b> = new capabilities as data (safe, instant). <b>Forge</b> = new plugin (gated + reviewed).</div>

      <h2 style="margin-top:16px">🔧 Self-Improve (ATLAS modifies itself)</h2>
      <div class="note">Ask ATLAS to improve a specific system (memory, brain, learning, etc). It reads its own code using only your free local brain (Ollama) and suggests a concrete change.</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <select id="improveTarget" style="flex:1">
          <option value="memory">Memory (storage &amp; recall)</option>
          <option value="memory-search">Memory search (semantic matching)</option>
          <option value="brain">Brain router (model selection)</option>
          <option value="learning">Learning (outcome tracking)</option>
          <option value="learning-proposals">Proposals (behavior suggestions)</option>
          <option value="orchestrator">Daily cycle (overall planning)</option>
          <option value="chat">Chat (how ATLAS talks to you)</option>
          <option value="codebase">Codebase scanner (project understanding)</option>
        </select>
      </div>
      <input id="improveGoal" placeholder="What should improve? E.g. 'faster recalls' or 'better reasoning'" style="margin-top:6px; width:100%" />
      <button onclick="requestSelfImprovement()" style="margin-top:6px">💭 Suggest improvement</button>
      <div id="improveOut" class="note" style="margin-top:10px"></div>
      <div id="improveDrafts" style="margin-top:14px"></div>

      <h2 style="margin-top:20px">Skills</h2>
      <input id="skName" placeholder="Skill name, e.g. Competitor pricing analysis" />
      <input id="skPurpose" placeholder="What it should be expert at" style="margin-top:6px" />
      <button onclick="createSkill()">✨ Invent skill</button>
      <div id="skList" class="note" style="margin-top:10px">Loading…</div>
      <div style="margin-top:8px"><input id="skInput" placeholder="input to run the selected skill on" style="width:60%;display:inline-block"/> <span id="skRunHint" class="note"></span></div>
      <pre id="skOut" class="hide"></pre>

      <h2 style="margin-top:20px">Forge (writes new plugin code)</h2>
      <input id="fgName" placeholder="Capability name, e.g. Headline optimizer" />
      <input id="fgPurpose" placeholder="What the new capability should do" style="margin-top:6px" />
      <button onclick="forgeDraft()">🔧 Draft plugin</button>
      <button class="sec" onclick="forgeVerify()">✅ Verify (typecheck)</button>
      <button class="sec" onclick="forgeActivate()">🚀 Request activation</button>
      <pre id="fgOut" class="hide"></pre>
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

      <label style="margin-top:14px">Drop in many sites at once (one URL per line) — ATLAS studies &amp; files notes for each</label>
      <textarea id="bulkUrls" rows="6" placeholder="https://a-tool-i-found.com&#10;https://competitor.com/pricing&#10;example.com/blog" style="font-family:monospace"></textarea>
      <button onclick="bulkLearn()">🎓 Study all sites</button>
      <pre id="bulkLearnOut" class="hide"></pre>

      <label style="margin-top:14px">Study a codebase you've built (folder path — read-only, changes nothing)</label>
      <div style="display:flex;gap:8px;"><input id="cbDir" placeholder="C:\\Users\\matbr\\claudecode1" style="flex:1" /><button style="margin-top:0" onclick="learnCodebase()">Study</button></div>
      <div class="note">Point it at your evervibes / wholesale folder. ATLAS reads the structure, configs, and workflows and writes an understanding to memory. It will not edit anything.</div>

      <label style="margin-top:14px">Import our Claude chat history (folder with .jsonl transcripts)</label>
      <div style="display:flex;gap:8px;"><input id="histDir" placeholder="C:\\Users\\matbr\\.claude\\projects\\C--Users-matbr-claudecode1" style="flex:1" /><button style="margin-top:0" onclick="importHistory()">Import</button></div>
      <div class="note">Reads the local Claude Code transcripts of everything we've built and files them into ATLAS's memory.</div>
    </section>

    <section id="tab-businesses" class="card hide">
      <div style="display:flex; height:min(70vh, 700px); gap:16px;">
        <aside style="width:260px; flex-shrink:0; border-right:1px solid var(--line); padding-right:16px; overflow-y:auto; display:flex; flex-direction:column; justify-content:space-between;">
          <div>
            <h2>Your Businesses</h2>
            <div id="bizList" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">Loading…</div>
          </div>
          <div style="border-top:1px solid var(--line); padding-top:12px; margin-top:16px;">
            <h3>Add a business</h3>
            <input id="bizName" placeholder="Business name" style="width:100%" />
            <input id="bizUrl" placeholder="https://its-website.com" style="margin-top:6px; width:100%" />
            <input id="bizGoal" placeholder="Goal, e.g. grow to $5k/mo" style="margin-top:6px; width:100%" />
            <button onclick="addBiz()" style="width:100%; margin-top:8px;">Add business</button>
          </div>
        </aside>
        <main style="flex:1; overflow-y:auto; padding-left:8px;">
          <div id="bizDetailPlaceholder" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--mut);">
            <span style="font-size:48px;">💼</span>
            <p>Select a business from the sidebar to view details, goal status, and trigger research.</p>
          </div>
          <div id="bizDetailBox" style="display:none; flex-direction:column; gap:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h2 id="bizDetailName" style="margin:0;">Business Name</h2>
              <span id="bizDetailStage" class="pill on" style="text-transform:uppercase;">Idea</span>
            </div>
            <div>
              <strong>Goal:</strong>
              <p id="bizDetailGoal" style="margin:4px 0 0 0; color:var(--txt);">No goal set.</p>
            </div>
            <div>
              <strong>Website:</strong>
              <p style="margin:4px 0 0 0;"><a id="bizDetailUrl" href="#" target="_blank" style="color:var(--acc);">https://example.com</a></p>
            </div>
            <div style="border-top:1px solid var(--line); padding-top:14px; margin-top:10px;">
              <h3>Research &amp; Learnings</h3>
              <div class="note">ATLAS runs an automated study on your business website each night to gather insights, competitor profiles, and growth targets.</div>
              <button class="mini" id="bizStudyBtn" style="margin-top:8px;">⚡ Study Website Now</button>
              <pre id="bizDetailStudyOut" class="hide" style="margin-top:12px; white-space:pre-wrap; background:rgba(0,0,0,0.2); padding:10px; border-radius:4px; border-left:3px solid var(--acc); max-height:300px; overflow-y:auto; font-family:monospace;"></pre>
            </div>
          </div>
        </main>
      </div>
    </section>

    <section id="tab-keys" class="card hide">
      <h2>🔑 Encrypted Secrets &amp; Credentials Vault</h2>
      <div class="note">Store all credentials locally and securely. Values are encrypted on disk using your master password and never leave this device.</div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 14px;">
        <!-- Left Side: API Keys & Secrets -->
        <div style="border-right: 1px solid var(--line); padding-right: 20px;">
          <h3>Smart API Key Input</h3>
          <div class="note">Paste raw API keys (one per line). ATLAS will auto-detect the service and save it.</div>
          <textarea id="detectKeys" rows="4" placeholder="AIzaSy...&#10;gsk_...&#10;hf_...&#10;tvly-..." style="margin-top:8px;font-family:monospace;width:100%;"></textarea>
          <button onclick="detectAndShow()" style="width:100%;">🔍 Detect &amp; Save keys</button>
          <div id="detectOut" style="margin-top:12px"></div>

          <h3 style="margin-top:20px">Bulk Save (legacy/plaintext env)</h3>
          <textarea id="bulkKeys" rows="4" placeholder="GROQ_API_KEY=gsk_...&#10;GEMINI_API_KEY=...&#10;OPENROUTER_API_KEY=..." style="margin-top:8px;font-family:monospace;width:100%;"></textarea>
          <button onclick="bulkSave()" style="width:100%;">💾 Save all keys</button>
          <button class="sec" onclick="testKeys()" style="width:100%;margin-top:6px;">🧪 Test my keys (live)</button>
          <div id="bulkOut" class="note"></div>
          <div id="keyTestOut" class="note" style="margin-top:8px"></div>

          <h3 style="margin-top:20px">Active API Providers</h3>
          <div id="providers"></div>
          <label>Manual key name</label>
          <select id="keyName" style="width:100%;">
            <option>GROQ_API_KEY</option><option>GEMINI_API_KEY</option>
            <option>OPENROUTER_API_KEY</option><option>ANTHROPIC_API_KEY</option>
            <option>ELEVENLABS_API_KEY</option><option>FAL_API_KEY</option>
          </select>
          <label>Key value</label>
          <input id="keyVal" type="password" placeholder="paste key value" style="width:100%;" />
          <button onclick="saveKey()" style="width:100%;margin-top:8px;">Save key</button>
          <button class="sec" onclick="exportEnv()" style="width:100%;margin-top:6px;">🌙 Enable overnight runs (copy keys to this computer)</button>
        </div>

        <!-- Right Side: Platform Logins -->
        <div>
          <h3>Stored Platform Logins</h3>
          <div id="creds" style="margin-bottom:12px;"></div>
          <label>Platform</label>
          <input id="cPlat" placeholder="instagram" style="width:100%;" />
          <label>Username / email</label>
          <input id="cUser" placeholder="you@example.com" style="width:100%;" />
          <label>Password</label>
          <input id="cPass" type="password" placeholder="stored encrypted" style="width:100%;" />
          <label>Notes (optional)</label>
          <input id="cNote" placeholder="2FA backup codes, etc." style="width:100%;" />
          <button onclick="saveCred()" style="width:100%;margin-top:8px;">Save login</button>
        </div>
      </div>
    </section>

    <section id="tab-run" class="card hide">
      <h2>⚙️ Run Automation</h2>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div style="border-right: 1px solid var(--line); padding-right: 20px;">
          <h3>Manual Run</h3>
          <button onclick="runCycle()" style="width:100%;">▶ Run daily cycle (posts nothing)</button>
          <pre id="report" class="hide" style="margin-top:12px; max-height:400px; overflow-y:auto; background:rgba(0,0,0,0.2); padding:10px; border-radius:4px; font-family:monospace; white-space:pre-wrap;"></pre>
        </div>
        <div>
          <h3>⏰ Hourly Automation Daemon</h3>
          <div class="note">Enable this to let ATLAS run its autonomous business cycles (research, script drafting, asset generation, metrics gathering) in the background every hour.</div>
          <div style="display:flex; align-items:center; gap:10px; margin-top:12px; background:rgba(255,255,255,0.05); padding:12px; border-radius:4px;">
            <input type="checkbox" id="automationToggle" style="width:auto; margin:0;" onchange="toggleAutomation()" />
            <label for="automationToggle" style="font-weight:bold; margin:0; cursor:pointer;">Enable Hourly background automation</label>
          </div>
          <div id="automationStatus" class="note" style="margin-top:12px;">Status: Stopped</div>
        </div>
      </div>
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

    <section id="tab-proposals" class="card hide">
      <h2>💡 ATLAS's Proposals (what it learned)</h2>
      <div class="note">When a category keeps underperforming, ATLAS proposes a fix. Click ✅ Adopt to make it a standing directive — it's stored in memory and recalled by the chat and every daily cycle.</div>
      <div id="proposalsList" class="note" style="margin-top:10px">Loading…</div>
      <button class="sec" onclick="loadProposals()">Refresh</button>
    </section>

    <section id="tab-approvals" class="card hide">
      <h2>Awaiting your approval</h2>
      <div id="approvals">None loaded.</div>
    </section>

    <section id="tab-media-factory" class="card hide" style="max-width: 1200px;">
      <h2>🎬 Virtual Media Factory</h2>
      <p class="note" style="margin-bottom: 20px;">Manage, orchestrate, and monetize your AI creator network. Generate target concepts, strategy calendars, scripts, and analyze business performance.</p>
      
      <div style="display:flex; gap: 20px; min-height: 550px;">
        <!-- Left Sidebar: Creators List -->
        <aside style="width: 250px; flex-shrink: 0; border-right: 1px solid var(--line); padding-right: 15px;">
          <button style="width:100%; margin-bottom: 15px;" onclick="openCreatorCreateModal()">✚ Create Creator</button>
          <div id="mfCreatorsList" style="display: flex; flex-direction: column; gap: 8px;">
            <div class="note">Loading creators...</div>
          </div>
        </aside>

        <!-- Right Content Detail Box -->
        <div id="mfDetailBox" style="flex: 1; display: none; flex-direction: column; gap: 15px;">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 10px;">
            <div>
              <h3 id="mfCreatorName" style="margin:0;">Creator Name</h3>
              <code id="mfCreatorHandle" style="font-size: 13px; color: var(--acc);">@handle</code>
            </div>
            <div>
              <button class="mini sec" onclick="deleteCurrentCreator()">Delete Profile</button>
            </div>
          </div>

          <!-- Tab Navigation for Detail -->
          <div style="display: flex; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 8px;">
            <button class="mini" onclick="setMFSubTab('identity')">Identity</button>
            <button class="mini" onclick="setMFSubTab('memory')">Memory Book</button>
            <button class="mini" onclick="setMFSubTab('strategy')">Strategy Board</button>
            <button class="mini" onclick="setMFSubTab('production')">Production Pipeline</button>
            <button class="mini" onclick="setMFSubTab('monetization')">Monetization</button>
            <button class="mini" onclick="setMFSubTab('analytics')">BI Analytics</button>
          </div>

          <!-- Detail Sections -->
          <div id="mfSubTab-identity" class="mfSubTab">
            <h4>Identity Blueprint</h4>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
              <div>
                <label>Age Range / Gender</label>
                <div id="mfIdentityAgeGender" class="row">Loading...</div>
                <label>Appearance Profile</label>
                <div id="mfIdentityAppearance" class="note" style="white-space: pre-wrap;">Loading...</div>
                <label>Personality Traits</label>
                <div id="mfIdentityTraits" style="display:flex; gap:5px; flex-wrap:wrap; margin-top:5px;">Loading...</div>
              </div>
              <div>
                <label>Speaking Style</label>
                <div id="mfIdentitySpeaking" class="row">Loading...</div>
                <label>Humor Style</label>
                <div id="mfIdentityHumor" class="row">Loading...</div>
                <label>Background Story</label>
                <div id="mfIdentityBackground" class="note" style="white-space: pre-wrap;">Loading...</div>
              </div>
            </div>
          </div>

          <div id="mfSubTab-memory" class="mfSubTab hide">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
              <h4>Memory &amp; Evolution Book</h4>
              <button class="mini" onclick="openAddMemoryModal()">✚ Add Memory Record</button>
            </div>
            <div id="mfMemoriesList" style="display:flex; flex-direction:column; gap:8px; max-height: 350px; overflow-y:auto;">
              <div class="note">No memories saved. Add one to refine identity consistency.</div>
            </div>
          </div>

          <div id="mfSubTab-strategy" class="mfSubTab hide">
            <h4>Content Strategy Board</h4>
            
            <div style="border: 1px solid var(--line); padding: 15px; border-radius: 6px; margin-bottom: 15px; background: rgba(255,255,255,0.02)">
              <h5>🔍 Audience Intelligence &amp; Trend Scout</h5>
              <div style="display:flex; gap:10px; margin-bottom:10px;">
                <input id="scoutNiche" placeholder="Enter target niche (e.g. lifestyle fitness, passive income, travel)..." style="flex:1; margin-top:0;" />
                <button onclick="runScoutAgent()" style="margin-top:0;">Run Scout Agent</button>
              </div>
              <div id="scoutResults" class="note hide" style="white-space: pre-wrap; padding: 10px; border: 1px dashed var(--line); border-radius: 4px;"></div>
            </div>

            <div style="border: 1px solid var(--line); padding: 15px; border-radius: 6px; background: rgba(255,255,255,0.02)">
              <h5>📅 Content Strategy Planner</h5>
              <div style="display:flex; gap:10px; margin-bottom:10px;">
                <input id="planTrends" placeholder="Summarize trending focus (e.g. Summer routines, high volume workouts)..." style="flex:1; margin-top:0;" />
                <button onclick="runPlanAgent()" style="margin-top:0;">Generate Weekly Strategy</button>
              </div>
              <div id="planResults" class="note hide"></div>
            </div>
          </div>

          <div id="mfSubTab-production" class="mfSubTab hide">
            <h4>Content Production Pipeline</h4>
            <div id="mfProductionList" style="display:flex; flex-direction:column; gap:10px; max-height: 400px; overflow-y:auto;">
              <div class="note">No items planned. Use Strategy Board to generate weekly ideas.</div>
            </div>
          </div>

          <div id="mfSubTab-monetization" class="mfSubTab hide">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <h4>Monetization &amp; Links</h4>
              <button class="mini" onclick="openAddPartnershipModal()">✚ Add Monetization Deal</button>
            </div>
            <div id="mfPartnershipsList" style="display:flex; flex-direction:column; gap:8px;">
              <div class="note">No monetization partnerships configured.</div>
            </div>
          </div>

          <div id="mfSubTab-analytics" class="mfSubTab hide">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
              <h4>BI Analytics Dashboard</h4>
              <button class="mini sec" onclick="injectDemoAnalytics()">🧪 Simulate Performance Data</button>
            </div>
            
            <!-- KPIs -->
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
              <div class="row" style="flex-direction:column; align-items:flex-start; padding: 10px; border-radius:4px; border: 1px solid var(--line);">
                <span class="note" style="font-size: 11px;">Total Views</span>
                <span id="kpiViews" style="font-size: 20px; font-weight:bold;">0</span>
              </div>
              <div class="row" style="flex-direction:column; align-items:flex-start; padding: 10px; border-radius:4px; border: 1px solid var(--line);">
                <span class="note" style="font-size: 11px;">Total Likes</span>
                <span id="kpiLikes" style="font-size: 20px; font-weight:bold;">0</span>
              </div>
              <div class="row" style="flex-direction:column; align-items:flex-start; padding: 10px; border-radius:4px; border: 1px solid var(--line);">
                <span class="note" style="font-size: 11px;">Total Link Clicks</span>
                <span id="kpiClicks" style="font-size: 20px; font-weight:bold;">0</span>
              </div>
              <div class="row" style="flex-direction:column; align-items:flex-start; padding: 10px; border-radius:4px; border: 1px solid var(--line);">
                <span class="note" style="font-size: 11px;">Total Revenue</span>
                <span id="kpiRevenue" style="font-size: 20px; font-weight:bold; color: var(--acc);">$0.00</span>
              </div>
            </div>

            <!-- Business Intelligence Advice Box -->
            <div style="border: 1px solid var(--acc); padding: 12px; border-radius: 4px; background: rgba(34,211,238,0.03); margin-top: 10px;">
              <h5>💡 Business Intelligence Recommendation</h5>
              <div id="mfBIRecommendation" class="note">Analyzing statistics... generate more content data to populate decision guidance indicators.</div>
            </div>
          </div>
        </div>

        <!-- Placeholder when no creator is selected -->
        <div id="mfPlaceholderBox" style="flex: 1; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--line); border-radius: 6px;">
          <div class="note" style="text-align:center;">
            <h3>No Virtual Creator Selected</h3>
            <p>Select a creator from the left menu or create a new profile to get started.</p>
          </div>
        </div>
      </div>
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
    loadStatus(); loadProviders(); loadCreds(); loadChats(); loadAutomationStatus();
    bubble("bot", "ATLAS online. Ask me anything — business strategy, content ideas, or what I've been working on. Everything we discuss becomes part of my memory.");
    $("chatIn").focus();
  } catch (e) { $("lockErr").textContent = e.message; }
};
$("lockNow").onclick = async () => { try{ await api("/api/lock","POST"); }catch{} TOKEN=null; location.reload(); };

document.querySelectorAll("nav button[data-tab]").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button[data-tab]").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  ["chat","map","businesses","learn","connect","grow","vault","status","keys","run","actions","proposals","approvals","media-factory"].forEach(t => $("tab-"+t).classList.toggle("hide", t!==b.dataset.tab));
  if (b.dataset.tab==="approvals") loadApprovals();
  if (b.dataset.tab==="proposals") loadProposals();
  if (b.dataset.tab==="chat") $("chatIn").focus();
  if (b.dataset.tab==="businesses") loadBiz();
  if (b.dataset.tab==="actions") loadActions();
  if (b.dataset.tab==="vault") loadTools();
  if (b.dataset.tab==="grow") loadSkills();
  if (b.dataset.tab==="map") renderMap();
  if (b.dataset.tab==="keys") { loadCreds(); loadProviders(); }
  if (b.dataset.tab==="run") loadAutomationStatus();
  if (b.dataset.tab==="media-factory") loadCreators();
});

// ── Grow: skills + forge ──
let selectedSkill=null;
async function loadSkills(){ try { const r=await api("/api/skills"); const list=r.skills||[];
  $("skList").innerHTML = list.length ? list.map(s => "<div class='row'><span><b>"+s.name+"</b> · "+s.category+" · ran "+s.timesRun+"×</span><button class='mini' onclick=\\"pickSkill('"+s.id+"','"+s.name.replace(/'/g,"")+"')\\">use</button></div>").join("") : "<div class='note'>No skills yet. Invent one above — ATLAS writes the expert prompt itself.</div>";
  } catch(e){ $("skList").textContent=e.message; } }
async function createSkill(){ const name=$("skName").value.trim(), purpose=$("skPurpose").value.trim(); if(!name||!purpose) return; $("skOut").classList.remove("hide"); $("skOut").textContent="ATLAS is designing the skill…";
  try { const s=await api("/api/skills","POST",{name,purpose,category:"custom"}); $("skName").value="";$("skPurpose").value=""; $("skOut").textContent="✨ Created "+s.name+"\\n\\nIts expert prompt:\\n"+s.systemPrompt.slice(0,500); loadSkills(); } catch(e){ $("skOut").textContent="⚠ "+e.message; } }
function pickSkill(id,name){ selectedSkill=id; $("skRunHint").textContent="→ running: "+name; $("skInput").focus(); }
$("skInput") && $("skInput").addEventListener("keydown", async (e)=>{ if(e.key==="Enter" && selectedSkill){ const input=$("skInput").value; $("skOut").classList.remove("hide"); $("skOut").textContent="Running…"; try{ const r=await api("/api/skills/"+selectedSkill+"/run","POST",{input}); $("skOut").textContent=r.output; loadSkills(); }catch(err){ $("skOut").textContent="⚠ "+err.message; } } });
async function forgeDraft(){ const name=$("fgName").value.trim(), purpose=$("fgPurpose").value.trim(); if(!name||!purpose) return; $("fgOut").classList.remove("hide"); $("fgOut").textContent="ATLAS is writing the plugin…";
  try { const r=await api("/api/forge/draft","POST",{name,purpose,capability:name}); $("fgOut").textContent="🔧 Drafted "+r.file+"\\n\\n"+r.code.slice(0,900); } catch(e){ $("fgOut").textContent="⚠ "+e.message; } }
async function forgeVerify(){ $("fgOut").classList.remove("hide"); $("fgOut").textContent="Typechecking the whole project…";
  try { const r=await api("/api/forge/verify","POST"); $("fgOut").textContent=(r.ok?"✅ ":"❌ ")+r.output.slice(0,1500); } catch(e){ $("fgOut").textContent="⚠ "+e.message; } }
async function forgeActivate(){ const name=$("fgName").value.trim(); if(!name){ alert("Enter the capability name you drafted."); return; } try { const r=await api("/api/forge/activate","POST",{name}); alert("Backup taken. Activation sent to Approvals — approve it there to make it live (then relock/unlock)."); } catch(e){ alert(e.message);} }

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
const MAP_GROUPS = { core:["brain","memory","executive","approvals","guardian","backup","skills","forge"], create:["creative","publishing","personas","web"], intel:["research","opportunity","strategy","analytics","detective","simulation","knowledge","experiments","codebase","curiosity","archaeologist","legacy","search"], money:["cfo","negotiation","business","toolvault","connectors"], ops:["learning","automation","techdebt","engineering","compliance","actions","inbox","redteam","janitor","email"] };
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
async function bulkLearn(){ const text=$("bulkUrls").value; if(!text.trim()) return; $("bulkLearnOut").classList.remove("hide"); $("bulkLearnOut").textContent="Studying sites… (this can take a minute for many)";
  try { const r=await api("/api/learn/bulk","POST",{text}); $("bulkLearnOut").textContent="Studied "+r.total+" site(s):\\n"+(r.results||[]).map(x=>(x.ok?"✅ ":"⚠ ")+x.url+(x.ok?" — "+(x.title||""):" ("+x.error+")")).join("\\n"); } catch(e){ $("bulkLearnOut").textContent="⚠ "+e.message; } }
async function learnRepo(){ const repo=$("repoName").value.trim(); if(!repo) return; $("learnOut").classList.remove("hide"); $("learnOut").textContent="Analyzing "+repo+" …";
  try { const r = await api("/api/repo","POST",{repo}); $("learnOut").textContent = "📦 "+repo+"\\n\\n"+r.notes; } catch(e){ $("learnOut").textContent="⚠ "+e.message; } }
let activeBizId = null;

async function loadBiz() {
  try {
    const r = await api("/api/businesses");
    const list = r.businesses || [];
    const container = $("bizList");
    if (!list.length) {
      container.innerHTML = \`<div class="note">No businesses yet. Add your first below.</div>\`;
      $("bizDetailBox").style.display = "none";
      $("bizDetailPlaceholder").style.display = "flex";
      return;
    }
    container.innerHTML = list.map(b => \`
      <div class="row" style="cursor:pointer; \${activeBizId === b.id ? 'border:1px solid var(--acc); background:rgba(34,211,238,0.08);' : ''}" onclick="selectBiz('\${b.id}')">
        <span><b>\${b.name}</b><br><span style="font-size:11px;color:var(--mut);">\${b.stage || 'idea'}</span></span>
      </div>
    \`).join("");
  } catch (e) {
    $("bizList").innerHTML = \`<div class="err">\${e.message}</div>\`;
  }
}

async function selectBiz(id) {
  activeBizId = id;
  $("bizDetailPlaceholder").style.display = "none";
  $("bizDetailBox").style.display = "flex";
  
  loadBiz();
  
  try {
    const r = await api("/api/businesses");
    const biz = (r.businesses || []).find(b => b.id === id);
    if (!biz) return;

    $("bizDetailName").textContent = biz.name;
    $("bizDetailStage").textContent = biz.stage || "idea";
    $("bizDetailGoal").textContent = biz.goal || "No goal configured yet.";
    
    if (biz.url) {
      $("bizDetailUrl").href = biz.url;
      $("bizDetailUrl").textContent = biz.url;
      $("bizDetailUrl").style.display = "inline";
      $("bizStudyBtn").style.display = "inline-block";
      $("bizStudyBtn").onclick = () => researchBiz(biz.id);
    } else {
      $("bizDetailUrl").style.display = "none";
      $("bizStudyBtn").style.display = "none";
    }

    $("bizDetailStudyOut").classList.add("hide");
    $("bizDetailStudyOut").textContent = "";
  } catch (e) {
    alert("Error loading business details: " + e.message);
  }
}

async function addBiz() {
  const name = $("bizName").value.trim();
  const url = $("bizUrl").value.trim();
  const goal = $("bizGoal").value.trim();
  if (!name) return;
  try {
    await api("/api/businesses", "POST", { name, url, goal });
    ["bizName", "bizUrl", "bizGoal"].forEach(i => $(i).value = "");
    loadBiz();
  } catch (e) {
    alert(e.message);
  }
}

async function researchBiz(id) {
  const out = $("bizDetailStudyOut");
  out.classList.remove("hide");
  out.textContent = "ATLAS Agent is studying your business website & compiling market research...";
  try {
    const r = await api("/api/businesses/" + encodeURIComponent(id) + "/research", "POST");
    out.textContent = r.notes ? r.notes : ("Skipped: " + (r.skipped || ""));
    loadBiz();
  } catch (e) {
    out.textContent = "Error: " + e.message;
  }
}

// ── Chat + sessions (Claude-like sidebar) ──
let chatHistory = [];
let currentSessionId = null;
function bubble(role, text){
  const d = document.createElement("div");
  d.className = "bub " + (role==="user" ? "user" : "bot");
  d.textContent = text;
  $("chatBox").appendChild(d);
  $("chatBox").scrollTop = $("chatBox").scrollHeight;
  return d;
}

// Render the sidebar: chats grouped by project, loose chats, and recently deleted.
async function loadChats(){
  let data; try { data = await api("/api/chats"); } catch { return; }
  const byProj = {};
  const deletedChats = [];
  for (const s of data.sessions){
    if (s.deleted) {
      deletedChats.push(s);
    } else {
      (byProj[s.project||""] = byProj[s.project||""]||[]).push(s);
    }
  }
  const chatList = $("chatList"); chatList.innerHTML="";
  const projList = $("projList"); projList.innerHTML="";
  const delList = $("deletedList"); delList.innerHTML="";

  // Projects first (with their chats)
  const projNames = Object.keys(byProj).filter(p=>p).sort();
  for (const p of projNames){
    const h=document.createElement("div"); h.className="projGroup"; h.textContent="📁 "+p; projList.appendChild(h);
    for (const s of byProj[p]) projList.appendChild(chatRow(s));
  }

  // Loose chats
  for (const s of (byProj[""]||[])) chatList.appendChild(chatRow(s));
  if(!(byProj[""]||[]).length) chatList.innerHTML='<div class="note" style="margin:4px">No loose chats yet.</div>';

  // Deleted chats
  for (const s of deletedChats) delList.appendChild(deletedChatRow(s));
  if(!deletedChats.length) delList.innerHTML='<div class="note" style="margin:4px">Trash is empty.</div>';
}
function chatRow(s){
  const d=document.createElement("div");
  d.className="chatItem"+(s.id===currentSessionId?" active":"");
  d.innerHTML='<span style="overflow:hidden;text-overflow:ellipsis">'+ (s.title||"New chat").replace(/</g,"&lt;") +'</span><span class="del" title="Delete">✕</span>';
  d.querySelector("span").onclick=()=>openChat(s.id);
  d.onclick=(e)=>{ if(!e.target.classList.contains("del")) openChat(s.id); };
  d.querySelector(".del").onclick=async(e)=>{ e.stopPropagation(); if(!confirm("Move this chat to Recently Deleted?"))return; await api("/api/chats/"+s.id,"DELETE"); if(s.id===currentSessionId){ openChat(s.id); } else { loadChats(); } };
  return d;
}
function deletedChatRow(s){
  const d=document.createElement("div");
  d.className="chatItem"+(s.id===currentSessionId?" active":"");
  d.innerHTML='<span style="overflow:hidden;text-overflow:ellipsis;text-decoration:line-through;color:var(--mut)">🗑️ '+ (s.title||"Deleted chat").replace(/</g,"&lt;") +'</span><span style="margin-left:auto;display:flex;gap:6px;"><span class="restore" title="Restore" style="cursor:pointer">↩️</span><span class="purge" title="Delete permanently" style="cursor:pointer;color:var(--bad)">✕</span></span>';
  d.onclick=(e)=>{ if(!e.target.classList.contains("restore") && !e.target.classList.contains("purge")) openChat(s.id); };
  d.querySelector(".restore").onclick=async(e)=>{
    e.stopPropagation();
    await api("/api/chats/"+s.id, "PATCH", { deleted: false });
    if (s.id === currentSessionId) { openChat(s.id); } else { loadChats(); }
  };
  d.querySelector(".purge").onclick=async(e)=>{
    e.stopPropagation();
    if(!confirm("Permanently delete this chat forever?")) return;
    await api("/api/chats/"+s.id + "?purge=true", "DELETE");
    if(s.id===currentSessionId){currentSessionId=null;$("chatBox").innerHTML="";$("chatTitle").textContent="Talk to ATLAS";$("chatProj").textContent="";$("renameChatBtn").style.display="none";$("moveProjBtn").style.display="none";}
    loadChats();
  };
  return d;
}
async function openChat(id){
  const s = await api("/api/chats/"+id);
  currentSessionId = id;
  chatHistory = s.messages.map(m=>({role:m.role,text:m.text}));
  $("chatBox").innerHTML="";
  for (const m of s.messages) bubble(m.role, m.text);
  $("chatTitle").textContent = s.title||"Chat";
  
  if (s.deleted) {
    $("renameChatBtn").style.display = "none";
    $("moveProjBtn").style.display = "none";
    $("chatProj").textContent = "🗑️ Deleted";
  } else {
    $("chatProj").textContent = s.project ? "📁 "+s.project : "";
    $("renameChatBtn").style.display = "inline-block";
    $("moveProjBtn").style.display = "inline-block";
    $("renameChatBtn").onclick = async () => {
      const newTitle = prompt("Rename chat:", s.title || "");
      if (newTitle !== null && newTitle.trim()) {
        await api("/api/chats/"+id, "PATCH", { title: newTitle.trim() });
        openChat(id);
      }
    };
    $("moveProjBtn").onclick = async () => {
      const newProj = prompt("Enter project name (empty for Inbox):", s.project || "");
      if (newProj !== null) {
        await api("/api/chats/"+id, "PATCH", { project: newProj.trim() });
        openChat(id);
      }
    };
  }
  loadChats();
}
async function newChat(){
  const s = await api("/api/chats","POST",{});
  currentSessionId = s.id;
  chatHistory = [];
  $("chatBox").innerHTML="";
  $("chatTitle").textContent = "New chat";
  $("chatProj").textContent = "";
  $("renameChatBtn").style.display = "none";
  $("moveProjBtn").style.display = "none";
  bubble("bot","New chat started. What are we working on?");
  loadChats();
  $("chatIn").focus();
}
async function sendChat(){
  const msg = $("chatIn").value.trim();
  if (!msg) return;
  if (!currentSessionId){ try { const s=await api("/api/chats","POST",{}); currentSessionId=s.id; } catch{} }
  $("chatIn").value = "";
  bubble("user", msg);
  const thinking = bubble("bot", "…thinking");
  try {
    const r = await api("/api/chat","POST",{ message: msg, history: chatHistory, sessionId: currentSessionId });
    thinking.textContent = r.reply;
    chatHistory.push({role:"user",text:msg},{role:"bot",text:r.reply});
    const secs = (r.latencyMs/1000).toFixed(1);
    const warn = r.provider==="stub" ? " ⚠️ (see reply for why the live brains failed)" : "";
    $("chatMeta").textContent = "Answered by "+r.provider+" ("+r.model+") in "+secs+"s · saved"+warn;
    
    // Update active chat title/buttons once auto-named
    const activeSession = await api("/api/chats/" + currentSessionId);
    if (activeSession && !activeSession.deleted) {
      $("chatTitle").textContent = activeSession.title;
      $("chatProj").textContent = activeSession.project ? "📁 " + activeSession.project : "";
      $("renameChatBtn").style.display = "inline-block";
      $("moveProjBtn").style.display = "inline-block";
      $("renameChatBtn").onclick = async () => {
        const newTitle = prompt("Rename chat:", activeSession.title || "");
        if (newTitle !== null && newTitle.trim()) {
          await api("/api/chats/"+currentSessionId, "PATCH", { title: newTitle.trim() });
          openChat(currentSessionId);
        }
      };
      $("moveProjBtn").onclick = async () => {
        const newProj = prompt("Enter project name (empty for Inbox):", activeSession.project || "");
        if (newProj !== null) {
          await api("/api/chats/"+currentSessionId, "PATCH", { project: newProj.trim() });
          openChat(currentSessionId);
        }
      };
    }
    loadChats();
  } catch(e){ thinking.textContent = "⚠ " + e.message; }
}
$("chatSend").onclick = sendChat;
$("newChat").onclick = newChat;
$("chatIn").addEventListener("keydown", (e) => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

// 🎤 speech-to-text (browser Web Speech API — free, no server cost)
(function(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("chatMic");
  if (!SR) { mic.disabled = true; mic.title = "Speech not supported in this browser (use Chrome)"; return; }
  let rec = null, on = false;
  mic.onclick = () => {
    if (on && rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    let base = $("chatIn").value ? $("chatIn").value + " " : "";
    rec.onstart = () => { on = true; mic.textContent = "🔴"; mic.title = "Listening… tap to stop"; };
    rec.onresult = (e) => { let t = ""; for (let i=e.resultIndex;i<e.results.length;i++) t += e.results[i][0].transcript; $("chatIn").value = base + t; };
    rec.onerror = () => { on = false; mic.textContent = "🎤"; };
    rec.onend = () => { on = false; mic.textContent = "🎤"; mic.title = "Speak"; $("chatIn").focus(); };
    rec.start();
  };
})();

async function loadStatus() {
  try { const s = await api("/api/status");
    $("statusBox").innerHTML =
      row("Plugins active", s.pluginCount) + row("Brain", s.brainMode) +
      row("Publisher", s.publisher) + row("Platform logins stored", s.credentials) +
      "<div class='note'>To go live: " + s.checklist.filter(c=>!c.done).map(c=>c.item).join(" · ") + "</div>";
  } catch(e){ $("statusBox").textContent = e.message; }
}
async function loadProviders() {
  try {
    const s = await api("/api/secrets");
    const providers = s.providers || {};
    const customKeys = s.customKeys || [];
    const providerRows = Object.entries(providers).map(([k,v]) =>
      "<div class='row'><span>"+k+"</span><span class='pill "+(v?"on":"off")+"'>"+(v?"set":"missing")+"</span></div>").join("");
    const customRows = customKeys.map(k =>
      "<div class='row'><span>"+k+"</span><span class='pill on'>custom</span><button class='mini sec' onclick='deleteKey(\\""+k+"\\")'>remove</button></div>").join("");
    const header = providerRows ? "<div class='note'>Known providers:</div>" : "";
    const customHeader = customRows ? "<div class='note' style='margin-top:12px'>Custom keys (unknown services):</div>" : "";
    $("providers").innerHTML = header + providerRows + customHeader + customRows;
  } catch(e) { $("providers").textContent = "Error: "+e.message; }
}
async function saveKey(){ try { await api("/api/secrets","POST",{name:$("keyName").value, value:$("keyVal").value}); $("keyVal").value=""; loadProviders(); loadStatus(); } catch(e){ alert(e.message);} }
async function exportEnv(){ try { const r = await api("/api/export-env","POST"); alert("Done — "+r.exported+" key(s) enabled for overnight runs on this computer."); } catch(e){ alert(e.message);} }

// Self-improvement (ATLAS modifies itself)
async function requestSelfImprovement(){ const target=$("improveTarget").value; const goal=$("improveGoal").value;
  if(!target||!goal) return alert("Select a target and goal");
  $("improveOut").textContent="Thinking (using local brain, no token cost)…";
  try { const r=await api("/api/self-improve","POST",{target,goal});
    $("improveOut").innerHTML="<b>✅ Draft ready</b> (confidence: "+(r.draft.confidence*100|0)+"%)<div class='note' style='margin-top:8px'>"+r.draft.explanation+"</div>";
    $("improveDrafts").innerHTML="<div class='row' style='align-items:flex-start;border:1px solid var(--acc);padding:8px;border-radius:4px;margin-top:8px'><span><b>"+r.draft.target+"</b><br><code style='font-size:11px'>"+r.draft.estimatedImpact+"</code></span><div><button onclick='reviewDraft(\\""+r.id+"\\")'>Review code</button> <button class='sec' onclick='rejectDraft(\\""+r.id+"\\")'>Reject</button></div></div>";
  } catch(e){ $("improveOut").textContent="⚠ "+e.message; } }
async function reviewDraft(id){ try { const r=await api("/api/self-improve/drafts/"+id);
  const code=r.draft.suggestedPatch.split("\\n").slice(0,20).join("\\n");
  $("improveDrafts").innerHTML+="<pre style='background:var(--bg2);padding:8px;margin-top:8px;font-size:11px;border-left:2px solid var(--acc)'>"+code+"…</pre><button onclick='applyDraft(\\""+id+"\\")' style='margin-top:8px'>✅ Approve &amp; apply</button>";
} catch(e){ alert(e.message); } }
async function applyDraft(id){ try { await api("/api/self-improve/apply","POST",{id,approved:true});
  $("improveDrafts").textContent="✅ Improvement applied! Rebuilding ATLAS…"; $("improveGoal").value="";
  setTimeout(()=>{ $("improveOut").textContent=""; $("improveDrafts").textContent=""; }, 3000);
} catch(e){ alert(e.message); } }
async function rejectDraft(id){ $("improveDrafts").textContent="Rejected. Ask for another idea."; $("improveGoal").value=""; }

// Proposals dashboard (learning → adopted directives)
let proposalsCache=[];
async function loadProposals(){ try { const r=await api("/api/proposals"); proposalsCache=r.proposals||[];
  const props=proposalsCache.map((p,i)=>"<div class='row'><span><b>"+p.problem+"</b><br><span class='note'>"+p.suggestion+"</span></span><div><button onclick='adoptProposal("+i+")'>✅ Adopt</button></div></div>").join("");
  $("proposalsList").innerHTML=props||"<div class='note'>No proposals yet. ATLAS raises one when a category keeps failing (needs 3+ recorded outcomes under 50% success) — they appear here as it operates.</div>";
} catch(e){ $("proposalsList").textContent="⚠ "+e.message; } }
async function adoptProposal(i){ const p=proposalsCache[i]; if(!p) return;
  try { const r=await api("/api/proposals/adopt","POST",{category:p.category,problem:p.problem,suggestion:p.suggestion});
    alert(r.message||"Adopted"); loadProposals();
  } catch(e){ alert(e.message); } }

let detectedKeysCache=[];
async function detectAndShow(){ const text=$("detectKeys").value; if(!text.trim()) return; $("detectOut").textContent="Detecting…";
  try { const r=await api("/api/detect-keys","POST",{text}); detectedKeysCache=r.detected||[]; const html=(r.detected||[]).map((d,i)=>
    "<div class='row' style='align-items:center'><input type='checkbox' id='ck"+i+"' data-idx='"+i+"' checked /><span><b>"+d.label+"</b> <code>"+d.name+"</code> <span class='note'>"+d.category+(d.free?" · free":"")+(d.sensitive?" · sensitive":"")+(d.alreadySaved?" · will UPDATE the saved one":" · new")+
    "</span></span></div>").join("");
    if(!html) { $("detectOut").textContent="⚠ No keys detected. Paste raw API keys (AIzaSy..., gsk_..., hf_..., etc.)"; return; }
    $("detectOut").innerHTML=html+"<div style='margin-top:12px'><button onclick='saveDetected()'>💾 Save selected keys</button> ("+r.total+" detected)</div>"; } catch(e){ $("detectOut").textContent="⚠ "+e.message; } }
async function saveDetected(){ const indices=Array.from(document.querySelectorAll("#detectOut input[type=checkbox]:checked")).map(c=>parseInt(c.dataset.idx||"0"));
  if(!indices.length) return alert("Select at least one key");
  $("detectOut").textContent="Saving…";
  try { let saved=0;
    for(const idx of indices) { const d=detectedKeysCache[idx]; if(!d) continue; await api("/api/secrets","POST",{name:d.name,value:d.value}); saved++; }
    $("detectOut").textContent="✅ Saved "+saved+" key(s)"; $("detectKeys").value=""; detectedKeysCache=[]; loadProviders(); loadStatus();
  } catch(e){ $("detectOut").textContent="⚠ "+e.message; } }
async function bulkSave(){ const text=$("bulkKeys").value; if(!text.trim()) return; $("bulkOut").textContent="Saving…";
  try { const r=await api("/api/secrets/bulk","POST",{text}); const unknown=(r.names||[]).filter(n=>!["GROQ_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","ANTHROPIC_API_KEY","HUGGINGFACE_API_KEY","TAVILY_API_KEY","GITHUB_TOKEN"].includes(n)); $("bulkOut").innerHTML="✅ Saved "+r.saved+" key(s)"+(unknown.length?" ("+unknown.length+" custom)":""); $("bulkKeys").value=""; loadProviders(); loadStatus(); } catch(e){ $("bulkOut").textContent="⚠ "+e.message; } }
async function deleteKey(name){ if(!confirm("Remove "+name+"?")) return; try { await api("/api/secrets/"+name,"DELETE"); loadProviders(); } catch(e){ alert(e.message); } }
async function testKeys(){ $("keyTestOut").textContent="Testing each key against its real provider…";
  try { const r=await api("/api/keys/test");
    $("keyTestOut").innerHTML=(r.results||[]).map(x=>{
      const cls=x.status==="valid"?"on":"off";
      return "<div class='row'><span>"+x.name+"</span><span class='pill "+cls+"'>"+x.status+"</span><span class='note'>"+x.detail+"</span></div>";
    }).join("");
  } catch(e){ $("keyTestOut").textContent="⚠ "+e.message; } }
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
// ── Virtual Media Factory Logic ──
let activeCreatorId = null;
let activeMFSubTab = "identity";

async function loadCreators() {
  try {
    const list = await api("/api/media-factory/creators");
    const container = $("mfCreatorsList");
    if (!list.length) {
      container.innerHTML = \`<div class="note">No virtual creators. Create your first profile below.</div>\`;
      $("mfDetailBox").style.display = "none";
      $("mfPlaceholderBox").style.display = "flex";
      return;
    }
    container.innerHTML = list.map(c => \`
      <div class="row" style="cursor:pointer; \${activeCreatorId === c.id ? 'border:1px solid var(--acc); background:rgba(34,211,238,0.08);' : ''}" onclick="selectCreator('\${c.id}')">
        <span><b>\${c.name}</b><br><code style="font-size:11px;color:var(--mut);">@\${c.handle}</code></span>
      </div>
    \`).join("");
  } catch (e) {
    $("mfCreatorsList").innerHTML = \`<div class="err">\${e.message}</div>\`;
  }
}

async function selectCreator(id) {
  activeCreatorId = id;
  $("mfPlaceholderBox").style.display = "none";
  $("mfDetailBox").style.display = "flex";
  
  loadCreators();
  
  try {
    const creators = await api("/api/media-factory/creators");
    const creator = creators.find(c => c.id === id);
    if (!creator) return;

    $("mfCreatorName").textContent = creator.name;
    $("mfCreatorHandle").textContent = \`@\${creator.handle}\`;
    
    $("mfIdentityAgeGender").innerHTML = \`<span><b>Age:</b> \${creator.age_range}</span> <span><b>Gender:</b> \${creator.gender}</span>\`;
    $("mfIdentityAppearance").textContent = creator.appearance_profile.description || creator.appearance_profile;
    $("mfIdentityTraits").innerHTML = creator.personality_traits.map(t => \`<span class="pill on" style="font-size:11px;">\${t}</span>\`).join(" ");
    $("mfIdentitySpeaking").textContent = creator.speaking_style;
    $("mfIdentityHumor").textContent = creator.humor_style;
    $("mfIdentityBackground").textContent = creator.background_story;

    triggerMFSubTabLoad();
  } catch (e) {
    alert("Error loading creator details: " + e.message);
  }
}

function setMFSubTab(tabName) {
  activeMFSubTab = tabName;
  document.querySelectorAll(".mfSubTab").forEach(el => el.classList.add("hide"));
  $("mfSubTab-" + tabName).classList.remove("hide");
  triggerMFSubTabLoad();
}

function triggerMFSubTabLoad() {
  if (!activeCreatorId) return;
  if (activeMFSubTab === "memory") loadMemories();
  if (activeMFSubTab === "production") loadContentItems();
  if (activeMFSubTab === "monetization") loadPartnerships();
  if (activeMFSubTab === "analytics") loadAnalytics();
}

async function openCreatorCreateModal() {
  const name = prompt("Enter Virtual Creator Name (e.g. Maya Chen):");
  if (!name) return;
  const handle = prompt("Enter Handle (lowercase, no spaces, e.g. mayafit):");
  if (!handle) return;
  const age_range = prompt("Enter Age Range (e.g. 22-26):", "21-25");
  if (!age_range) return;
  const gender = prompt("Enter Gender (e.g. Female):", "Female");
  if (!gender) return;
  const description = prompt("Describe Physical Appearance & Style:");
  if (!description) return;
  const background = prompt("Enter Background Story:");
  if (!background) return;
  const speaking = prompt("Enter Speaking Style:", "Chill and conversational");
  const humor = prompt("Enter Humor Style:", "Meme-oriented and lighthearted");
  const brand = prompt("Enter Brand Positioning (e.g. Sustainable fitness guide):");

  const c = {
    name, handle, age_range, gender,
    appearance_profile: { description },
    personality_traits: ["motivated", "insightful", "witty"],
    speaking_style: speaking,
    humor_style: humor,
    values_statement: "Empowering conscious digital lifestyles.",
    background_story: background,
    interests: ["fitness", "sustainability", "travel"],
    content_pillars: ["daily_routines", "tips", "mindset"],
    target_audience: { demographic: "18-35 digital natives" },
    brand_positioning: brand
  };

  try {
    const res = await api("/api/media-factory/creators", "POST", c);
    activeCreatorId = res.id;
    loadCreators();
    selectCreator(res.id);
  } catch (e) {
    alert("Error creating creator: " + e.message);
  }
}

async function deleteCurrentCreator() {
  if (!activeCreatorId) return;
  if (!confirm("Are you sure you want to delete this creator profile? All memories and content drafts will be deleted.")) return;
  try {
    await api("/api/media-factory/creators/" + activeCreatorId, "DELETE");
    activeCreatorId = null;
    loadCreators();
  } catch (e) {
    alert("Error deleting creator: " + e.message);
  }
}

async function loadMemories() {
  try {
    const list = await api("/api/media-factory/memories/" + activeCreatorId);
    const container = $("mfMemoriesList");
    if (!list.length) {
      container.innerHTML = \`<div class="note">No memories saved yet. Add a success/failure lesson below.</div>\`;
      return;
    }
    container.innerHTML = list.map(m => \`
      <div class="row">
        <span><span class="pill \${m.kind === 'success' ? 'on' : 'off'}">\${m.kind}</span> \${m.content}</span>
        <button class="mini sec" onclick="deleteMemory('\${m.id}')">✕</button>
      </div>
    \`).join("");
  } catch (e) {
    $("mfMemoriesList").innerHTML = \`<div class="err">\${e.message}</div>\`;
  }
}

async function openAddMemoryModal() {
  const kind = prompt("Enter Memory Kind ('success' | 'failure' | 'lesson'):", "success");
  if (!kind || !["success", "failure", "lesson"].includes(kind)) return;
  const content = prompt("Enter Memory Details (e.g., Short aesthetic Reels about packing gear get 3x higher comments):");
  if (!content) return;

  try {
    await api("/api/media-factory/memories", "POST", { creator_id: activeCreatorId, kind, content });
    loadMemories();
  } catch (e) {
    alert("Error adding memory: " + e.message);
  }
}

async function deleteMemory(id) {
  try {
    await api("/api/media-factory/memories/" + id, "DELETE");
    loadMemories();
  } catch (e) {
    alert("Error deleting memory: " + e.message);
  }
}

async function runScoutAgent() {
  const niche = $("scoutNiche").value.trim();
  if (!niche) return;
  $("scoutResults").classList.remove("hide");
  $("scoutResults").textContent = "Audience scout agent is analyzing trends...";
  try {
    const res = await api("/api/media-factory/scout", "POST", { niche });
    $("scoutResults").textContent = JSON.stringify(res, null, 2);
  } catch (e) {
    $("scoutResults").textContent = "Error: " + e.message;
  }
}

async function runPlanAgent() {
  const summary = $("planTrends").value.trim();
  $("planResults").classList.remove("hide");
  $("planResults").textContent = "Content planner agent is generating weekly schedule...";
  try {
    const list = await api("/api/media-factory/plan", "POST", { creatorId: activeCreatorId, trendsSummary: summary });
    $("planResults").innerHTML = list.map((item, idx) => \`
      <div style="border-bottom: 1px solid var(--line); padding: 8px 0;">
        <strong>[\${item.platform.toUpperCase()}] \${item.title}</strong><br>
        <span class="note" style="display:block; margin: 4px 0;">Hook: "\${item.hook}"</span>
        <button class="mini" onclick="addCalendarToPipeline(\${idx}, '\${item.title.replace(/'/g,"")}', '\${item.platform}', '\${item.hook.replace(/'/g,"")}', '\${item.brief.replace(/'/g,"")}')">✚ Add to Production Pipeline</button>
      </div>
    \`).join("");
  } catch (e) {
    $("planResults").textContent = "Error: " + e.message;
  }
}

async function addCalendarToPipeline(idx, title, platform, hook, brief) {
  const item = {
    creator_id: activeCreatorId,
    title,
    platform,
    status: "draft",
    hook,
    script: "",
    caption: "",
    assets: { visual_brief: brief }
  };
  try {
    await api("/api/media-factory/content", "POST", item);
    alert("Successfully added to production queue!");
    setMFSubTab("production");
  } catch (e) {
    alert("Error saving item: " + e.message);
  }
}

async function loadContentItems() {
  try {
    const list = await api("/api/media-factory/content?creatorId=" + activeCreatorId);
    const container = $("mfProductionList");
    if (!list.length) {
      container.innerHTML = \`<div class="note">No content planned yet. Go to Strategy Board to plan items.</div>\`;
      return;
    }
    container.innerHTML = list.map(item => \`
      <div style="border: 1px solid var(--line); padding: 12px; border-radius: 4px;">
        <div style="display:flex; justify-content:space-between;">
          <strong>[\${item.platform.toUpperCase()}] \${item.title}</strong>
          <span class="pill \${item.status === 'published' ? 'on' : (item.status === 'review' ? 'on' : 'off')}" style="text-transform:uppercase;">\${item.status}</span>
        </div>
        <p class="note" style="margin: 6px 0;"><b>Hook:</b> "\${item.hook}"</p>
        \${item.script ? \`<div style="background:rgba(0,0,0,0.2); padding:8px; border-radius:4px; margin-top:8px; font-size:13px; font-family:monospace; border-left:3px solid var(--acc); white-space:pre-wrap;"><b>Voiceover:</b> \${item.script}</div>\` : ''}
        \${item.caption ? \`<p class="note" style="margin-top:6px;"><b>Caption:</b> \${item.caption}</p>\` : ''}
        <div style="margin-top: 10px; display:flex; gap: 6px;">
          \${item.status === 'draft' ? \`<button class="mini" onclick="runProductionAgent('\${item.id}', '\${item.title.replace(/'/g,"")}', '\${item.hook.replace(/'/g,"")}', '\${(item.assets?.visual_brief || '').replace(/'/g,"")}', '\${item.platform}')">⚡ Run Prod Agent</button>\` : ''}
          \${item.status === 'review' ? \`<button class="mini" onclick="requestHumanPublishApproval('\${item.id}', '\${item.title.replace(/'/g,"")}')">🔒 Send for Approval</button>\` : ''}
          \${item.status === 'approved' ? \`<button class="mini" onclick="publishContent('\${item.id}')">🚀 Publish Live</button>\` : ''}
          \${item.status !== 'published' ? \`<button class="mini sec" onclick="publishContent('\${item.id}')">Quick Publish (bypass)</button>\` : ''}
        </div>
      </div>
    \`).join("");
  } catch (e) {
    $("mfProductionList").innerHTML = \`<div class="err">\${e.message}</div>\`;
  }
}

async function runProductionAgent(id, title, hook, brief, platform) {
  try {
    alert("Running Content Production Agent... this will take a few seconds.");
    const res = await api("/api/media-factory/produce", "POST", { creatorId: activeCreatorId, title, hook, brief, platform });
    
    await api("/api/media-factory/content/" + id, "PATCH", { status: "review" });
    
    await api("/api/media-factory/content", "POST", {
      id,
      creator_id: activeCreatorId,
      title, platform,
      status: "review",
      hook,
      script: res.script,
      caption: res.caption,
      hashtags: res.hashtags,
      assets: { image_prompt: res.image_prompt, visual_brief: brief }
    });
    
    loadContentItems();
  } catch (e) {
    alert("Production Agent failed: " + e.message);
  }
}

async function requestHumanPublishApproval(id, title) {
  try {
    await api("/api/approvals", "POST", {
      action: \`Publish Content Reel: "\${title}"\`,
      payload: { contentId: id },
      category: "media_factory_publish"
    });
    
    await api("/api/media-factory/content/" + id, "PATCH", { status: "approved" });
    alert("Sent approval task to Approvals tab!");
    loadContentItems();
  } catch (e) {
    alert("Failed creating approval: " + e.message);
  }
}

async function publishContent(id) {
  try {
    await api("/api/media-factory/content/" + id, "PATCH", { status: "published", publishedAt: new Date().toISOString() });
    alert("Reel/Post marked as published and live!");
    loadContentItems();
  } catch (e) {
    alert("Publishing failed: " + e.message);
  }
}

async function loadPartnerships() {
  try {
    const list = await api("/api/media-factory/partnerships/" + activeCreatorId);
    const container = $("mfPartnershipsList");
    if (!list.length) {
      container.innerHTML = \`<div class="note">No monetization partnerships configured yet.</div>\`;
      return;
    }
    container.innerHTML = list.map(p => \`
      <div class="row">
        <span><b>\${p.name}</b> (\${p.kind}) &rarr; <a href="\${p.destination_url}" target="_blank">\${p.destination_url}</a></span>
        <span class="pill \${p.active ? 'on' : 'off'}">\${p.active ? 'active' : 'inactive'}</span>
      </div>
    \`).join("");
  } catch (e) {
    $("mfPartnershipsList").innerHTML = \`<div class="err">\${e.message}</div>\`;
  }
}

async function openAddPartnershipModal() {
  const name = prompt("Enter Partnership/Product Name (e.g. FlexiFit Affiliate):");
  if (!name) return;
  const kind = prompt("Enter Kind ('affiliate' | 'sponsorship' | 'digital_product'):", "affiliate");
  if (!kind) return;
  const urlStr = prompt("Enter Destination URL:");
  if (!urlStr) return;

  try {
    await api("/api/media-factory/partnerships", "POST", { creator_id: activeCreatorId, name, kind, destination_url: urlStr, promotional_scripts: [] });
    loadPartnerships();
  } catch (e) {
    alert("Failed adding partnership: " + e.message);
  }
}

async function loadAnalytics() {
  try {
    const list = await api("/api/media-factory/analytics/" + activeCreatorId);
    if (!list.length) {
      $("kpiViews").textContent = "0";
      $("kpiLikes").textContent = "0";
      $("kpiClicks").textContent = "0";
      $("kpiRevenue").textContent = "$0.00";
      $("mfBIRecommendation").textContent = "No analytics data. Click 'Simulate Performance Data' to populate test signals.";
      return;
    }
    
    let totalViews = 0, totalLikes = 0, totalClicks = 0, totalRev = 0;
    list.forEach(s => {
      totalViews += s.views;
      totalLikes += s.likes;
      totalClicks += s.clicks;
      totalRev += parseFloat(s.revenue);
    });

    $("kpiViews").textContent = totalViews.toLocaleString();
    $("kpiLikes").textContent = totalLikes.toLocaleString();
    $("kpiClicks").textContent = totalClicks.toLocaleString();
    $("kpiRevenue").textContent = "$" + totalRev.toFixed(2);

    const convRate = totalViews > 0 ? (totalClicks / totalViews) * 100 : 0;
    let rec = "";
    if (convRate > 2.5) {
      rec = \`📈 **SCALE UP:** Engagement and click conversion rate is excellent (\${convRate.toFixed(1)}%). Recommended to scale daily post output by +1 per day and increase direct affiliate pitch links.\`;
    } else if (totalViews > 10000 && convRate < 0.8) {
      rec = \`🔄 **PIVOT TOPICS:** High views (\${totalViews}) but low CTR (\${convRate.toFixed(1)}%). The audience is watching, but visual assets lack persuasive CTA overlays. Refine scripts to add strong bios and hook links.\`;
    } else {
      rec = \`🌱 **NURTURE PHASE:** Normal engagement levels detected. Keep running content production cycles consistent with visual pillars to establish baseline growth indicators.\`;
    }
    $("mfBIRecommendation").textContent = rec;
  } catch (e) {
    alert("Analytics load failed: " + e.message);
  }
}

async function injectDemoAnalytics() {
  if (!activeCreatorId) return;
  const snap = {
    creator_id: activeCreatorId,
    views: Math.floor(Math.random() * 25000) + 5000,
    likes: Math.floor(Math.random() * 3000) + 300,
    comments: Math.floor(Math.random() * 400) + 30,
    shares: Math.floor(Math.random() * 150) + 15,
    clicks: Math.floor(Math.random() * 900) + 50,
    revenue: parseFloat((Math.random() * 450).toFixed(2))
  };
  try {
    await api("/api/media-factory/analytics", "POST", snap);
    loadAnalytics();
  } catch (e) {
    alert("Simulation failed: " + e.message);
  }
}

async function loadAutomationStatus() {
  try {
    const res = await api("/api/automation");
    $("automationToggle").checked = res.enabled;
    $("automationStatus").innerHTML = \`
      <b>Status:</b> \${res.enabled ? '🟢 Active background daemon' : '🔴 Stopped'}<br>
      <b>Last Run:</b> \${res.lastRun ? new Date(res.lastRun).toLocaleString() : 'Never'}<br>
      <b>Running Cycle:</b> \${res.running ? '🔄 Yes' : 'No'}
    \`;
  } catch (e) {
    console.error("Failed loading automation status:", e);
  }
}

async function toggleAutomation() {
  const enabled = $("automationToggle").checked;
  try {
    await api("/api/automation", "POST", { enabled });
    loadAutomationStatus();
  } catch (e) {
    alert("Failed toggling automation: " + e.message);
    $("automationToggle").checked = !enabled;
  }
}

boot();
</script>
</body>
</html>`;
