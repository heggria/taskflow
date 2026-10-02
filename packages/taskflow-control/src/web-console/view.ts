/** Static shell only. All owner-provided content is inserted with textContent. */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taskflow · Operator console</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><header><div><strong>Taskflow</strong><span class="subtitle">Operator console</span></div><span id="connection" role="status">Disconnected</span></header>
<section id="login" class="login"><h1>Connect to your local control service</h1><p>Enter the one-use session token provided by your trusted launcher. The token stays on this machine.</p><label for="token">Launcher session token</label><input id="token" type="password" autocomplete="off" spellcheck="false"><button id="connect">Connect</button><p id="login-error" role="alert"></p></section>
<div id="console" hidden><aside><div class="section-heading"><h2>Projects</h2><button id="refresh-projects" class="quiet">Refresh</button></div><div id="projects"></div><button id="logout" class="quiet">End browser session</button></aside>
<main><div class="section-heading"><div><h1 id="project-title">Select a project</h1><p id="project-context" class="mono muted"></p></div><button id="refresh" class="quiet">Refresh view</button></div>
<p id="notice" role="status" aria-live="polite"></p><nav aria-label="Project views"><button data-tab="runs" class="selected">Runs</button><button data-tab="approvals">Approvals</button><button data-tab="evidence">Receipt & evidence</button></nav>
<section id="runs-panel"><h2>Runs</h2><p class="muted">Status and stage are reported by the project ledger.</p><div id="runs"></div><pre id="run-detail" hidden></pre></section>
<section id="approvals-panel" hidden><h2>Approval inbox</h2><p id="edit-capability" class="muted"></p><div id="approvals"></div></section>
<section id="evidence-panel" hidden><h2>Receipt & evidence</h2><label for="run-choice">Run</label><select id="run-choice"></select><div class="actions"><button id="receipt">View receipt</button><button id="why-stale" class="quiet">Why stale</button><input id="effect-id" placeholder="Effect ID" aria-label="Effect ID"><input id="phase-id" placeholder="Phase ID (optional)" aria-label="Phase ID"><button id="why-effect" class="quiet">Why effect</button></div><p class="muted">Receipts are issued by control after final settlement. Missing evidence is never treated as verified.</p><pre id="evidence-output">Choose a run to inspect its committed evidence.</pre></section>
<details><summary>Control connection details</summary><pre id="control-status"></pre></details></main></div>
<footer>Local operator session · Live authorization remains with ControlHost</footer></body></html>`;

export const CONSOLE_CSS = `:root{color-scheme:light;--ink:#192a30;--muted:#67777c;--line:#dce4e6;--accent:#146a60;--canvas:#f6f8f8}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{height:68px;padding:0 30px;background:white;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}header strong{font-size:20px;letter-spacing:-.6px}.subtitle{margin-left:18px;color:var(--muted)}#connection{font-size:12px;border:1px solid var(--line);padding:4px 10px;border-radius:20px}.login{max-width:610px;margin:70px auto;padding:32px;background:#fff;border:1px solid var(--line);border-radius:12px}h1{font-size:23px;letter-spacing:-.5px;margin:0 0 8px}h2{font-size:16px;margin:0}p{margin:8px 0 18px}.muted{color:var(--muted)}.mono,pre{font-family:ui-monospace,SFMono-Regular,monospace}label{display:block;margin:14px 0 6px;font-weight:600}input,select,textarea{font:inherit;padding:8px 10px;background:white;border:1px solid #b8c8cc;border-radius:6px;color:var(--ink)}input:focus,select:focus,textarea:focus{outline:2px solid #8ac5bb;outline-offset:2px}#token{width:100%;margin-bottom:14px}button{font:inherit;font-weight:600;cursor:pointer;background:var(--accent);color:white;border:1px solid var(--accent);border-radius:6px;padding:7px 13px}button:hover{filter:brightness(.95)}button:disabled{cursor:not-allowed;opacity:.48}.quiet{background:white;color:var(--ink);border-color:var(--line)}#console{display:grid;grid-template-columns:246px minmax(0,1fr);min-height:calc(100vh - 110px)}#console[hidden]{display:none}aside{padding:25px 18px;border-right:1px solid var(--line);background:#eef3f2}main{padding:30px 36px;max-width:1400px;width:100%}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:20px}.section-heading p{margin-bottom:0;font-size:11px;overflow-wrap:anywhere}.project{display:block;width:100%;text-align:left;margin:8px 0;padding:12px;background:transparent;border:1px solid transparent;color:var(--ink);overflow-wrap:anywhere}.project.selected{background:white;border-color:#c5d7d2;box-shadow:0 1px 3px #163c3010}.project small{display:block;color:var(--muted);font-weight:400;margin-top:5px}#logout{margin-top:28px;width:100%}nav{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:20px 0 25px;padding-bottom:10px}nav button{background:transparent;color:var(--muted);border-color:transparent}nav button.selected{background:#e4efeb;color:#155f53}#notice{min-height:22px;margin:0;color:var(--muted)}#notice.error,#login-error{color:#9c3131}.card{background:white;border:1px solid var(--line);border-radius:9px;padding:17px;margin:12px 0}.card h3{margin:0 0 6px;font-size:14px;overflow-wrap:anywhere}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.tag{display:inline-block;background:#edf1f2;color:#385158;font-size:12px;border-radius:4px;padding:2px 7px;margin-right:6px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.actions input{width:180px}.empty{padding:28px;border:1px dashed #c6d3d5;border-radius:8px;color:var(--muted);background:#fcfdfd}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:18px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:12px}textarea{display:block;width:100%;min-height:70px;margin:12px 0}details{margin-top:30px;color:var(--muted)}summary{cursor:pointer}footer{padding:10px 30px;font-size:11px;color:var(--muted);border-top:1px solid var(--line)}[hidden]{display:none!important}@media(max-width:800px){#console{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}main{padding:24px 18px}.subtitle{display:none}.row{align-items:flex-start}.section-heading{align-items:flex-start}.login{margin:30px 15px}header{padding:0 18px}}`;

export const CONSOLE_JS = String.raw`'use strict';
const $ = (id) => document.getElementById(id);
const state = { csrf: '', features: {}, project: null, projects: [], runs: [], generation: 0, commands: new Map() };
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function clear(e) { e.replaceChildren(); }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function message(error) { return (error.code ? error.code + ': ' : '') + error.message; }
async function api(path, body, method) {
 const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (state.csrf) headers['X-Taskflow-CSRF'] = state.csrf;
 const response = await fetch(path, { method: method || (body === undefined ? 'GET' : 'POST'), headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 const value = await response.json(); if (!response.ok) { const e = new Error(value.error?.message || 'Control request failed'); e.code = value.error?.code; if (response.status === 401) $('connection').textContent = 'Session expired'; throw e; } return value;
}
function projectUrl(project, suffix) { return '/api/projects/' + encodeURIComponent(project.projectId) + suffix + '?controlDomainId=' + encodeURIComponent(project.controlDomainId); }
function empty(parent, text) { parent.append(node('p', text, 'empty')); }
function tab(name) { for (const n of ['runs', 'approvals', 'evidence']) $(n + '-panel').hidden = name !== n; for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('selected', b.dataset.tab === name); }
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => tab(b.dataset.tab));
function renderProjects() {
 clear($('projects')); if (!state.projects.length) empty($('projects'), 'No authorized projects are mounted.');
 for (const p of state.projects) { const b = node('button', undefined, 'project'); b.classList.toggle('selected', state.project?.projectId === p.projectId); b.append(node('span', p.name || p.path || p.projectId), node('small', p.mountState || 'Mounted project')); b.addEventListener('click', () => { state.project = p; renderProjects(); void refreshProject(); }); $('projects').append(b); }
}
function renderRuns(runs, project) {
 clear($('runs')); clear($('run-choice')); state.runs = runs;
 if (!runs.length) { empty($('runs'), 'No runs in this project.'); $('run-choice').append(node('option', 'No runs available')); }
 for (const r of runs) {
  const option = node('option', r.runId); option.value = r.runId; $('run-choice').append(option);
  const card = node('div', undefined, 'card'); const row = node('div', undefined, 'row'); const info = node('div'); info.append(node('h3', r.runId));
  const labels = node('div'); for (const value of [r.status, r.stage, 'slot: ' + r.slot]) labels.append(node('span', value, 'tag')); if (r.needsOperator) labels.append(node('span', 'Needs operator', 'tag')); info.append(labels);
  const details = node('button', 'Inspect', 'quiet'); details.addEventListener('click', async () => { const g = state.generation; notice('Loading run…'); try { const data = await api(projectUrl(project, '/runs/' + encodeURIComponent(r.runId))); if (g !== state.generation) return; $('run-detail').hidden = false; $('run-detail').textContent = JSON.stringify(data.result, null, 2); $('run-choice').value = r.runId; notice('Run loaded from control.'); } catch (e) { if (g === state.generation) notice(message(e), true); } });
  row.append(info, details); card.append(row); $('runs').append(card);
 }
 for (const id of ['receipt', 'why-stale', 'why-effect']) $(id).disabled = runs.length === 0;
}
function renderApprovals(approvals, project) {
 clear($('approvals')); $('edit-capability').textContent = state.features.approvalEditWithArtifactRef ? 'Editing requires an existing, authorized output ArtifactRef.' : 'Editing is not supported by the connected control service.';
 if (!approvals.length) empty($('approvals'), 'No approval requests in this project.');
 for (const a of approvals) {
  const card = node('div', undefined, 'card'); card.append(node('h3', a.message || a.approvalRequestId), node('p', 'Run ' + a.runId + ' · version ' + a.expectedRunVersion + ' · ' + a.status, 'mono muted'), node('p', 'Deadline: ' + new Date(a.deadline).toLocaleString(), 'muted'));
  const editRef = node('textarea'); editRef.placeholder = 'Output ArtifactRef JSON'; editRef.setAttribute('aria-label', 'Output ArtifactRef JSON'); editRef.hidden = !state.features.approvalEditWithArtifactRef || !a.allowedDecisions.includes('edit'); card.append(editRef);
  const buttons = node('div', undefined, 'actions');
  for (const decision of a.allowedDecisions) {
   const b = node('button', decision[0].toUpperCase() + decision.slice(1), decision === 'approve' ? '' : 'quiet'); b.disabled = a.status !== 'pending' || (decision === 'edit' && !state.features.approvalEditWithArtifactRef); b.addEventListener('click', async () => {
    const g = state.generation; const peers = Array.from(buttons.querySelectorAll('button')); peers.forEach(x => x.disabled = true); notice('Submitting ' + decision + '…');
    try {
     const editArtifactRef = decision === 'edit' ? JSON.parse(editRef.value) : undefined;
     const key = [project.projectId, a.approvalRequestId, a.expectedRunVersion, decision, JSON.stringify(editArtifactRef)].join(':');
     if (!state.commands.has(key)) state.commands.set(key, crypto.randomUUID());
     const body = { commandId: state.commands.get(key), runId: a.runId, expectedRunVersion: a.expectedRunVersion, decision, ...(editArtifactRef === undefined ? {} : { editArtifactRef }) };
     await api(projectUrl(project, '/approvals/' + encodeURIComponent(a.approvalRequestId) + '/decisions'), body);
     if (g !== state.generation) return; await refreshProject(); notice('Decision committed by control.');
    } catch (e) {
     if (g !== state.generation) return;
     if (e.code === 'TF_STALE_VERSION') await refreshProject();
     notice(message(e) + (e.code === 'TF_STALE_VERSION' ? ' The current request has been refreshed; review before deciding again.' : ''), true);
     peers.forEach(x => x.disabled = a.status !== 'pending' || (x.textContent === 'Edit' && !state.features.approvalEditWithArtifactRef));
    }
   }); buttons.append(b);
  }
  card.append(buttons); $('approvals').append(card);
 }
}
async function refreshProject() {
 const p = state.project; const g = ++state.generation; $('run-detail').hidden = true; clear($('run-detail')); clear($('runs')); clear($('approvals')); clear($('run-choice')); $('evidence-output').textContent = 'Choose a run to inspect its committed evidence.';
 for (const id of ['receipt', 'why-stale', 'why-effect']) $(id).disabled = true;
 if (!p) { $('project-title').textContent = 'Select a project'; $('project-context').textContent = ''; return; }
 $('project-title').textContent = p.name || p.path || p.projectId; $('project-context').textContent = p.projectId + ' · domain ' + p.controlDomainId; notice('Loading project…');
 const results = await Promise.allSettled([api(projectUrl(p, '/runs')), api(projectUrl(p, '/approvals'))]); if (g !== state.generation) return;
 const errors = [];
 for (let i = 0; i < results.length; i++) { const r = results[i]; const target = $(i === 0 ? 'runs' : 'approvals'); if (r.status === 'fulfilled' && Array.isArray(r.value.result)) { if (i === 0) renderRuns(r.value.result, p); else renderApprovals(r.value.result, p); } else { const text = r.status === 'rejected' ? message(r.reason) : 'Control returned an invalid list'; empty(target, text); errors.push(text); } }
 notice(errors.length ? errors.join(' · ') : 'Updated from the project ledger.', errors.length > 0);
}
async function projects() {
 notice('Loading projects…');
 try { const data = await api('/api/projects'); if (!Array.isArray(data.result)) throw new Error('Control returned an invalid project list'); state.projects = data.result; state.project = state.projects.find(p => p.projectId === state.project?.projectId) || state.projects[0] || null; renderProjects(); await refreshProject(); }
 catch (e) { state.projects = []; state.project = null; renderProjects(); await refreshProject(); notice(message(e), true); }
}
async function connected(session) {
 state.csrf = session.csrf; state.features = session.features; $('token').value = ''; $('login').hidden = true; $('console').hidden = false; $('connection').textContent = 'Local session';
 try { const status = await api('/api/status'); $('control-status').textContent = JSON.stringify(status.result, null, 2); } catch (e) { $('control-status').textContent = message(e); }
 await projects();
}
$('connect').addEventListener('click', async () => { $('connect').disabled = true; $('login-error').textContent = ''; try { const secret = $('token').value; $('token').value = ''; await connected(await api('/api/session', { token: secret })); } catch (e) { $('login-error').textContent = message(e); } finally { $('connect').disabled = false; } });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect').click(); });
$('refresh-projects').addEventListener('click', () => { void projects(); }); $('refresh').addEventListener('click', () => { void refreshProject(); });
$('logout').addEventListener('click', async () => { try { await api('/api/session', undefined, 'DELETE'); location.reload(); } catch (e) { notice(message(e), true); } });
async function evidence(kind) {
 const p = state.project; const runId = $('run-choice').value; if (!p || !runId || !state.runs.length) return;
 const g = state.generation; $('evidence-output').textContent = 'Loading evidence…';
 try { let url = projectUrl(p, '/runs/' + encodeURIComponent(runId) + (kind === 'receipt' ? '/receipt' : '/why')); if (kind !== 'receipt') url += '&kind=' + kind; if (kind === 'effect') url += '&effectId=' + encodeURIComponent($('effect-id').value); if ($('phase-id').value) url += '&phaseId=' + encodeURIComponent($('phase-id').value); const data = await api(url); if (g !== state.generation) return; $('evidence-output').textContent = data.result === null && kind === 'receipt' ? 'No final Receipt has been issued for this run.' : JSON.stringify(data.result, null, 2); }
 catch (e) { if (g === state.generation) $('evidence-output').textContent = message(e); }
}
$('receipt').addEventListener('click', () => { void evidence('receipt'); }); $('why-stale').addEventListener('click', () => { void evidence('stale'); }); $('why-effect').addEventListener('click', () => { void evidence('effect'); });
void api('/api/session').then(connected).catch(() => {});
`;
