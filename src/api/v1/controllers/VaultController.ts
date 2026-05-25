import { Request, Response, Router } from 'express';
import { DocumentVaultMongoRepository, DocumentVaultEntry } from '../../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
import { randomUUID } from 'crypto';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class VaultController {
  public router: Router;

  constructor(private vaultRepo: DocumentVaultMongoRepository) {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Basic Auth Middleware — validates both username AND password
    this.router.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Vault"');
        return res.status(401).send('Authentication required.');
      }

      const b64auth = authHeader.split(' ')[1] || '';
      const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

      const validUser = process.env.VAULT_USERNAME || 'karen';
      const validPassword = process.env.VAULT_PASSWORD;

      if (!validPassword) {
        console.error('[VAULT] VAULT_PASSWORD env variable is not set. Access denied.');
        return res.status(500).send('Server misconfiguration: no vault password set.');
      }

      if (login === validUser && password === validPassword) {
        return next();
      }

      res.set('WWW-Authenticate', 'Basic realm="Vault"');
      return res.status(401).send('Invalid credentials.');
    });

    this.router.get('/', this.renderDashboard.bind(this));
    this.router.get('/api', this.getDocuments.bind(this));
    this.router.post('/api', this.addDocument.bind(this));
    this.router.delete('/api/:id', this.deleteDocument.bind(this));
  }

  private async renderDashboard(_req: Request, res: Response) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vault — Secure Document Store</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ink: #0a0a0f;
      --ink2: #3a3a4a;
      --ink3: #7a7a8a;
      --surface: #f5f4f0;
      --card: #ffffff;
      --border: rgba(10,10,15,0.10);
      --border-strong: rgba(10,10,15,0.22);
      --accent: #2c2cff;
      --accent-dim: rgba(44,44,255,0.08);
      --accent-text: #1a1aee;
      --danger: #d93025;
      --danger-dim: rgba(217,48,37,0.08);
      --success: #137333;
      --success-dim: rgba(19,115,51,0.08);
      --amber: #b06000;
      --amber-dim: rgba(176,96,0,0.08);
      --shadow: 0 1px 3px rgba(0,0,0,0.07), 0 4px 12px rgba(0,0,0,0.05);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06);
      --radius: 10px;
      --radius-sm: 6px;
    }

    html { font-size: 16px; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--surface);
      color: var(--ink);
      min-height: 100vh;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }

    /* ── TOPBAR ── */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(245,244,240,0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 2rem;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .topbar-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 1rem;
      letter-spacing: -0.01em;
      color: var(--ink);
    }

    .brand-icon {
      width: 30px;
      height: 30px;
      background: var(--ink);
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .brand-icon svg { color: white; }

    .topbar-meta {
      font-family: 'DM Mono', monospace;
      font-size: 0.72rem;
      color: var(--ink3);
      letter-spacing: 0.04em;
    }

    /* ── LAYOUT ── */
    .page { max-width: 900px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }

    .hero {
      margin-bottom: 2.5rem;
    }

    .hero-label {
      font-family: 'DM Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.12em;
      color: var(--ink3);
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }

    .hero-title {
      font-family: 'Syne', sans-serif;
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: var(--ink);
      line-height: 1.15;
    }

    /* ── STATS ROW ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.1rem 1.25rem;
      box-shadow: var(--shadow);
    }

    .stat-label {
      font-size: 0.72rem;
      font-family: 'DM Mono', monospace;
      letter-spacing: 0.06em;
      color: var(--ink3);
      text-transform: uppercase;
      margin-bottom: 0.4rem;
    }

    .stat-value {
      font-family: 'Syne', sans-serif;
      font-size: 1.7rem;
      font-weight: 700;
      color: var(--ink);
      line-height: 1;
    }

    .stat-value.accent { color: var(--accent-text); }

    /* ── PANELS ── */
    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      margin-bottom: 1.5rem;
      overflow: hidden;
    }

    .panel-header {
      padding: 1.1rem 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .panel-title {
      font-family: 'Syne', sans-serif;
      font-size: 0.9rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .panel-body { padding: 1.5rem; }

    /* ── FORM ── */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 12px;
      align-items: end;
    }

    .field label {
      display: block;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--ink2);
      margin-bottom: 6px;
      letter-spacing: 0.01em;
    }

    .field input {
      width: 100%;
      height: 40px;
      padding: 0 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      font-family: 'DM Sans', sans-serif;
      font-size: 0.875rem;
      color: var(--ink);
      background: var(--surface);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }

    .field input:focus {
      border-color: var(--accent);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(44,44,255,0.12);
    }

    .field input::placeholder { color: var(--ink3); }

    .btn {
      height: 40px;
      padding: 0 20px;
      border: none;
      border-radius: var(--radius-sm);
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      font-size: 0.82rem;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: transform 0.12s, opacity 0.15s, box-shadow 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
    }

    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

    .btn-primary {
      background: var(--ink);
      color: #fff;
    }

    .btn-primary:hover:not(:disabled) { background: #1a1a2e; }

    .btn-danger {
      background: var(--danger-dim);
      color: var(--danger);
      border: 1px solid rgba(217,48,37,0.18);
      padding: 0 12px;
      height: 32px;
      font-size: 0.77rem;
    }

    .btn-danger:hover:not(:disabled) { background: rgba(217,48,37,0.15); }

    /* ── TOAST ── */
    #toast-container {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-radius: var(--radius);
      font-size: 0.85rem;
      font-weight: 500;
      box-shadow: var(--shadow-lg);
      border: 1px solid var(--border);
      min-width: 240px;
      animation: slideIn 0.25s ease;
      background: var(--card);
    }

    .toast.success { border-left: 3px solid var(--success); }
    .toast.error   { border-left: 3px solid var(--danger);  }

    .toast-icon { font-size: 1rem; }
    .toast.success .toast-icon { color: var(--success); }
    .toast.error   .toast-icon { color: var(--danger);  }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(20px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    @keyframes fadeOut {
      to { opacity: 0; transform: translateX(10px); }
    }

    /* ── TABLE ── */
    .doc-table-wrap { overflow-x: auto; }

    .doc-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }

    .doc-table th {
      font-family: 'DM Mono', monospace;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink3);
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .doc-table td {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    .doc-table tbody tr {
      transition: background 0.1s;
    }

    .doc-table tbody tr:hover { background: rgba(44,44,255,0.025); }
    .doc-table tbody tr:last-child td { border-bottom: none; }

    .doc-name {
      font-weight: 500;
      color: var(--ink);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .doc-icon {
      width: 28px;
      height: 28px;
      background: var(--accent-dim);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 0.7rem;
      font-family: 'DM Mono', monospace;
      color: var(--accent-text);
      font-weight: 500;
      letter-spacing: 0;
    }

    .doc-link-cell a {
      font-family: 'DM Mono', monospace;
      font-size: 0.75rem;
      color: var(--accent-text);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .doc-link-cell a:hover { text-decoration: underline; }

    .doc-id {
      font-family: 'DM Mono', monospace;
      font-size: 0.68rem;
      color: var(--ink3);
    }

    /* ── EMPTY / LOADING STATES ── */
    .state-box {
      padding: 3rem 1rem;
      text-align: center;
    }

    .state-box-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
      opacity: 0.25;
    }

    .state-box-title {
      font-family: 'Syne', sans-serif;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--ink2);
      margin-bottom: 0.25rem;
    }

    .state-box-sub {
      font-size: 0.8rem;
      color: var(--ink3);
    }

    .skeleton-row td {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    }

    .skel {
      height: 14px;
      border-radius: 4px;
      background: linear-gradient(90deg, var(--border) 25%, rgba(200,200,210,0.3) 50%, var(--border) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.4s infinite;
    }

    @keyframes shimmer {
      from { background-position: 200% 0; }
      to   { background-position: -200% 0; }
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 0.68rem;
      font-family: 'DM Mono', monospace;
      letter-spacing: 0.04em;
    }

    .badge-success { background: var(--success-dim); color: var(--success); }
    .badge-amber   { background: var(--amber-dim);   color: var(--amber);   }

    /* ── SEARCH BAR ── */
    .search-wrap {
      position: relative;
    }
    .search-wrap svg {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--ink3);
      pointer-events: none;
    }
    #searchInput {
      height: 36px;
      padding: 0 12px 0 34px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      font-family: 'DM Sans', sans-serif;
      font-size: 0.82rem;
      color: var(--ink);
      background: var(--surface);
      outline: none;
      width: 200px;
      transition: border-color 0.15s, width 0.2s ease;
    }
    #searchInput:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(44,44,255,0.10);
      width: 260px;
      background: #fff;
    }

    @media (max-width: 640px) {
      .form-grid { grid-template-columns: 1fr; }
      .stats-row { grid-template-columns: 1fr 1fr; }
      .hero-title { font-size: 1.6rem; }
      .topbar { padding: 0 1rem; }
      .page { padding: 1.5rem 1rem 3rem; }
    }
  </style>
</head>
<body>

<div id="toast-container"></div>

<div class="topbar">
  <div class="topbar-brand">
    <div class="brand-icon">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
    Vault
  </div>
  <span class="topbar-meta" id="vaultTime">—</span>
</div>

<div class="page">

  <div class="hero">
    <p class="hero-label">Secure Document Store</p>
    <h1 class="hero-title">Your documents,<br>locked &amp; organised.</h1>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <p class="stat-label">Total Docs</p>
      <p class="stat-value accent" id="statTotal">—</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Status</p>
      <p class="stat-value" style="font-size:1rem; padding-top:4px;">
        <span class="badge badge-success" id="statStatus">● Online</span>
      </p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Last Updated</p>
      <p class="stat-value" style="font-size:0.88rem; font-family:'DM Mono',monospace; padding-top:6px; color:var(--ink2);" id="statUpdated">—</p>
    </div>
  </div>

  <!-- ADD FORM -->
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Add Document</span>
    </div>
    <div class="panel-body">
      <div class="form-grid">
        <div class="field">
          <label for="docName">Document name</label>
          <input type="text" id="docName" placeholder="e.g. Aadhaar Card" autocomplete="off">
        </div>
        <div class="field">
          <label for="docLink">Secure link</label>
          <input type="url" id="docLink" placeholder="https://drive.google.com/…">
        </div>
        <button class="btn btn-primary" id="saveBtn" onclick="addDocument()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Save
        </button>
      </div>
    </div>
  </div>

  <!-- DOCUMENT TABLE -->
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Documents</span>
      <div class="search-wrap">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="searchInput" placeholder="Filter documents…" oninput="renderTable()">
      </div>
    </div>
    <div class="doc-table-wrap">
      <table class="doc-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Link</th>
            <th>ID</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="docTableBody">
          <tr class="skeleton-row"><td><div class="skel" style="width:60%"></div></td><td><div class="skel" style="width:80%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
          <tr class="skeleton-row"><td><div class="skel" style="width:45%"></div></td><td><div class="skel" style="width:70%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
          <tr class="skeleton-row"><td><div class="skel" style="width:55%"></div></td><td><div class="skel" style="width:60%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
        </tbody>
      </table>
    </div>
  </div>

</div>

<script>
  let allDocs = [];

  function safeText(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function initials(name) {
    return name.trim().split(/\\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  function toast(msg, type = 'success') {
    const icon = type === 'success' ? '✓' : '✕';
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + safeText(msg) + '</span>';
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => {
      el.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  function updateStats() {
    document.getElementById('statTotal').textContent = allDocs.length;
    const now = new Date();
    document.getElementById('statUpdated').textContent =
      now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderTable() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    const filtered = query
      ? allDocs.filter(d => d.name.toLowerCase().includes(query) || d.link.toLowerCase().includes(query))
      : allDocs;

    const tbody = document.getElementById('docTableBody');

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="state-box">' +
        '<div class="state-box-icon">🗂</div>' +
        '<p class="state-box-title">' + (query ? 'No results' : 'No documents yet') + '</p>' +
        '<p class="state-box-sub">' + (query ? 'Try a different search term.' : 'Add your first document above.') + '</p>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(doc => {
      const safeName = safeText(doc.name);
      const safeLink = safeText(doc.link);
      const safeId   = safeText(doc.docId);
      const abbr     = initials(doc.name);
      let hostLabel = '';
      try { hostLabel = new URL(doc.link).hostname.replace('www.','').split('.')[0]; } catch(e) {}

      return '<tr>' +
        '<td><div class="doc-name"><div class="doc-icon">' + safeText(abbr) + '</div>' + safeName + '</div></td>' +
        '<td class="doc-link-cell"><a href="' + safeLink + '" target="_blank" rel="noopener noreferrer">' +
          safeText(hostLabel || 'Open') +
          '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        '</a></td>' +
        '<td><span class="doc-id">' + safeId.slice(0,8) + '…</span></td>' +
        '<td><button class="btn btn-danger" onclick="deleteDoc(\'' + safeId + '\', this)">Remove</button></td>' +
      '</tr>';
    }).join('');
  }

  async function fetchDocs() {
    try {
      const res = await fetch('/vault/api?_t=' + Date.now(), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      allDocs = await res.json();
      updateStats();
      renderTable();
    } catch (err) {
      console.error('fetchDocs:', err);
      document.getElementById('statStatus').className = 'badge badge-amber';
      document.getElementById('statStatus').textContent = '● Degraded';
      document.getElementById('docTableBody').innerHTML =
        '<tr><td colspan="4"><div class="state-box">' +
        '<div class="state-box-icon">⚠</div>' +
        '<p class="state-box-title">Could not load documents</p>' +
        '<p class="state-box-sub">' + safeText(err.message) + '</p>' +
        '</div></td></tr>';
    }
  }

  async function addDocument() {
    const nameEl = document.getElementById('docName');
    const linkEl = document.getElementById('docLink');
    const btn    = document.getElementById('saveBtn');

    const name = nameEl.value.trim();
    const link = linkEl.value.trim();

    if (!name) { nameEl.focus(); toast('Document name is required.', 'error'); return; }
    if (!link)  { linkEl.focus(); toast('Secure link is required.', 'error'); return; }

    try { new URL(link); } catch {
      toast('Please enter a valid URL.', 'error');
      linkEl.focus();
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="animation:spin 0.8s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Saving…';

    try {
      const res = await fetch('/vault/api?_t=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name, link })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'HTTP ' + res.status);
      }

      const { doc } = await res.json();
      allDocs.unshift(doc);
      updateStats();
      renderTable();
      nameEl.value = '';
      linkEl.value = '';
      toast('Document saved securely.');
    } catch (err) {
      console.error('addDocument:', err);
      toast('Failed to save: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Save';
    }
  }

  async function deleteDoc(id, btnEl) {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    btnEl.disabled = true;
    btnEl.textContent = '…';

    try {
      const res = await fetch('/vault/api/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      allDocs = allDocs.filter(d => d.docId !== id);
      updateStats();
      renderTable();
      toast('Document removed.');
    } catch (err) {
      console.error('deleteDoc:', err);
      toast('Delete failed: ' + err.message, 'error');
      btnEl.disabled = false;
      btnEl.textContent = 'Remove';
    }
  }

  // Enter key on form fields
  document.getElementById('docName').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('docLink').focus(); });
  document.getElementById('docLink').addEventListener('keydown', e => { if (e.key === 'Enter') addDocument(); });

  // Clock
  function tick() {
    document.getElementById('vaultTime').textContent =
      new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  tick();
  setInterval(tick, 10000);

  // Spin keyframe injection
  const s = document.createElement('style');
  s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);

  fetchDocs();
</script>
</body>
</html>`;
    res.send(html);
  }

  private async getDocuments(_req: Request, res: Response) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
      const docs = await this.vaultRepo.findAll();
      res.json(docs);
    } catch (err) {
      console.error('[Vault] getDocuments error:', err);
      res.status(500).json({ error: 'Failed to retrieve documents.' });
    }
  }

  private async addDocument(req: Request, res: Response) {
    const { name, link } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Document name is required.' });
    }
    if (!link || typeof link !== 'string' || link.trim().length === 0) {
      return res.status(400).json({ error: 'Document link is required.' });
    }
    try { new URL(link); } catch {
      return res.status(400).json({ error: 'Invalid URL provided.' });
    }

    try {
      const doc: DocumentVaultEntry = {
        docId: randomUUID(),
        name: name.trim(),
        link: link.trim(),
        aliases: [name.trim().toLowerCase()]
      };
      await this.vaultRepo.save(doc);
      res.json({ success: true, doc });
    } catch (err) {
      console.error('[Vault] addDocument error:', err);
      res.status(500).json({ error: 'Failed to save document.' });
    }
  }

  private async deleteDocument(req: Request, res: Response) {
    const id = req.params.id as string;
    if (!id) return res.status(400).json({ error: 'Missing document ID.' });

    try {
      await this.vaultRepo.delete(id);
      res.json({ success: true });
    } catch (err) {
      console.error('[Vault] deleteDocument error:', err);
      res.status(500).json({ error: 'Failed to delete document.' });
    }
  }
}