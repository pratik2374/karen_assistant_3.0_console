import { Request, Response, Router } from 'express';
import { DocumentVaultMongoRepository, DocumentVaultEntry } from '../../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
import { randomUUID } from 'crypto';

// ─── DEBUG LOGGER ──────────────────────────────────────────────────────────
// Structured prefix makes it trivial to grep: grep "\[VAULT" server.log
const TAG = '[VAULT]';
function log(section: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`${ts} ${TAG}[${section}] ${msg}`, data);
  } else {
    console.log(`${ts} ${TAG}[${section}] ${msg}`);
  }
}
function logErr(section: string, msg: string, err: unknown) {
  const ts = new Date().toISOString();
  console.error(`${ts} ${TAG}[${section}] ❌ ${msg}`);
  if (err instanceof Error) {
    console.error(`  name   : ${err.name}`);
    console.error(`  message: ${err.message}`);
    console.error(`  stack  :\n${err.stack}`);
  } else {
    console.error('  raw err:', err);
  }
}
// ──────────────────────────────────────────────────────────────────────────

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
    log('INIT', 'VaultController constructor called');
    log('INIT', 'vaultRepo received?', !!vaultRepo);
    log('INIT', 'vaultRepo type', typeof vaultRepo);
    log('INIT', 'vaultRepo keys', vaultRepo ? Object.keys(vaultRepo) : 'N/A');

    this.router = Router();
    this.initializeRoutes();

    log('INIT', 'Router initialized, routes registered');
  }

  private initializeRoutes() {
    log('ROUTES', 'Registering middleware and routes');

    // ── AUTH MIDDLEWARE ──────────────────────────────────────────────────
    this.router.use((req, res, next) => {
      // Allow the login POST route to pass through
      if (req.path === '/login' && req.method === 'POST') {
        return next();
      }

      // Parse cookies
      const cookieHeader = req.headers.cookie || '';
      const cookies = Object.fromEntries(
        cookieHeader.split('; ').map(c => {
          const parts = c.split('=');
          return [parts[0], parts.slice(1).join('=')];
        })
      );

      const session = cookies.vault_session;
      const expectedSession = 'authenticated';

      if (session === expectedSession) {
        return next();
      }

      // If requesting API data, return a JSON 401
      if (req.path.startsWith('/api')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      // Otherwise, render the gorgeous login page
      return this.renderLoginPage(req, res);
    });

    this.router.get('/', this.renderDashboard.bind(this));
    this.router.post('/login', this.handleLogin.bind(this));
    this.router.post('/logout', this.handleLogout.bind(this));
    this.router.get('/api', this.getDocuments.bind(this));
    this.router.post('/api', this.addDocument.bind(this));
    this.router.delete('/api/:id', this.deleteDocument.bind(this));
    this.router.post('/api/bulk-delete', this.deleteBulk.bind(this));

    log('ROUTES', 'All routes registered: GET /, POST /login, POST /logout, GET /api, POST /api, DELETE /api/:id, POST /api/bulk-delete');
  }

  // ── CUSTOM LOGIN PAGE ────────────────────────────────────────────────────
  private renderLoginPage(_req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; connect-src 'self'; img-src 'self' data:;"
    );

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vault — Authenticate</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: radial-gradient(circle at 50% 50%, #151528 0%, #080810 100%);
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      overflow: hidden;
    }
    .grid-bg {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
      background-size: 30px 30px;
      background-position: center;
      z-index: 1;
      pointer-events: none;
    }
    .glow-orb {
      position: absolute;
      width: 400px; height: 400px;
      background: radial-gradient(circle, rgba(44,44,255,0.12) 0%, transparent 70%);
      border-radius: 50%;
      top: 20%; left: 30%;
      z-index: 2;
      pointer-events: none;
      filter: blur(40px);
      animation: float 8s ease-in-out infinite;
    }
    @keyframes float {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-20px) scale(1.05); }
    }
    .login-card {
      background: rgba(255,255,255,0.03);
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      width: 100%;
      max-width: 400px;
      padding: 2.5rem;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
      z-index: 10;
      position: relative;
      transition: transform 0.1s ease;
    }
    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      margin-bottom: 2rem;
      text-align: center;
    }
    .brand-icon {
      width: 42px; height: 42px;
      background: #ffffff;
      color: #080810;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 15px rgba(255,255,255,0.2);
    }
    .brand-title {
      font-family: 'Syne', sans-serif;
      font-weight: 800;
      font-size: 1.5rem;
      letter-spacing: -0.02em;
    }
    .brand-subtitle {
      font-size: 0.78rem;
      color: rgba(255,255,255,0.4);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .field {
      margin-bottom: 1.25rem;
    }
    .field label {
      display: block;
      font-size: 0.72rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: rgba(255,255,255,0.5);
      margin-bottom: 6px;
    }
    .field input {
      width: 100%;
      height: 44px;
      padding: 0 14px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      background: rgba(0,0,0,0.2);
      color: #ffffff;
      font-family: 'DM Sans', sans-serif;
      font-size: 0.9rem;
      outline: none;
      transition: all 0.2s ease;
    }
    .field input:focus {
      border-color: #2c2cff;
      background: rgba(0,0,0,0.4);
      box-shadow: 0 0 0 4px rgba(44,44,255,0.2);
    }
    .btn {
      width: 100%;
      height: 44px;
      background: #ffffff;
      color: #080810;
      border: none;
      border-radius: 8px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 0.9rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
      margin-top: 1.5rem;
    }
    .btn:hover {
      background: #e8e8ff;
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(44,44,255,0.25);
    }
    .btn:active {
      transform: translateY(0);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }
    .error-alert {
      background: rgba(217,48,37,0.12);
      border: 1px solid rgba(217,48,37,0.25);
      border-radius: 8px;
      padding: 10px 12px;
      color: #ff8f8f;
      font-size: 0.8rem;
      display: none;
      margin-bottom: 1.25rem;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .shake {
      animation: shake 0.4s ease;
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-8px); }
      40%, 80% { transform: translateX(8px); }
    }
    .footer-text {
      text-align: center;
      font-size: 0.72rem;
      color: rgba(255,255,255,0.3);
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="glow-orb"></div>

  <div class="login-card" id="loginCard">
    <div class="brand">
      <div class="brand-icon">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div>
        <h1 class="brand-title">Vault</h1>
        <p class="brand-subtitle">Secure Document Store</p>
      </div>
    </div>

    <div class="error-alert" id="errorAlert"></div>

    <form onsubmit="handleLogin(event)">
      <div class="field">
        <label for="username">Username</label>
        <input type="text" id="username" required autocomplete="username" placeholder="e.g. karen">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" required autocomplete="current-password" placeholder="••••••••">
      </div>
      <button class="btn" type="submit" id="submitBtn">
        Access Vault
      </button>
    </form>

    <p class="footer-text">Protected by end-to-end token validation</p>
  </div>

  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const userEl = document.getElementById('username');
      const passEl = document.getElementById('password');
      const btn = document.getElementById('submitBtn');
      const card = document.getElementById('loginCard');
      const errAlert = document.getElementById('errorAlert');

      const username = userEl.value.trim();
      const password = passEl.value;

      btn.disabled = true;
      btn.textContent = 'Verifying...';
      errAlert.style.display = 'none';

      try {
        const res = await fetch('/vault/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Authentication failed.');
        }

        window.location.reload();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Access Vault';
        
        errAlert.textContent = err.message;
        errAlert.style.display = 'block';
        
        card.classList.add('shake');
        setTimeout(() => card.classList.remove('shake'), 400);
      }
    }
  </script>
</body>
</html>`;

    res.send(html);
  }

  // ── HANDLE LOGIN POST ────────────────────────────────────────────────────
  private async handleLogin(req: Request, res: Response) {
    log('LOGIN', 'handleLogin() called');
    const { username, password } = req.body || {};
    const validUser = process.env.VAULT_USERNAME || 'karen';
    const validPassword = process.env.VAULT_PASSWORD;

    if (!validPassword) {
      console.error('[VAULT] VAULT_PASSWORD env variable is not set. Access denied.');
      return res.status(500).json({ error: 'Server misconfiguration.' });
    }

    if (username === validUser && password === validPassword) {
      log('LOGIN', '✅ Credentials verified — setting vault_session cookie');
      res.setHeader('Set-Cookie', 'vault_session=authenticated; Path=/vault; HttpOnly; SameSite=Strict; Max-Age=86400');
      return res.json({ success: true });
    }

    log('LOGIN', '❌ Invalid login attempt');
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // ── HANDLE LOGOUT POST ───────────────────────────────────────────────────
  private async handleLogout(_req: Request, res: Response) {
    log('LOGOUT', 'handleLogout() called — clearing vault_session cookie');
    res.setHeader('Set-Cookie', 'vault_session=; Path=/vault; HttpOnly; SameSite=Strict; Max-Age=0');
    return res.json({ success: true });
  }

  // ── DASHBOARD ────────────────────────────────────────────────────────────
  private async renderDashboard(_req: Request, res: Response) {
    log('DASHBOARD', 'Rendering dashboard HTML');

    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; connect-src 'self'; img-src 'self' data:;"
      );

      log('DASHBOARD', 'Response headers set, sending HTML now');

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
      --ink: #ffffff; --ink2: rgba(255, 255, 255, 0.75); --ink3: rgba(255, 255, 255, 0.45);
      --surface: radial-gradient(circle at 50% 50%, #151528 0%, #080810 100%);
      --card: rgba(255,255,255,0.03);
      --card-hover: rgba(255,255,255,0.06);
      --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.18);
      --accent: #5151ff; --accent-dim: rgba(81,81,255,0.12); --accent-text: #8c8cff;
      --danger: #ff4a5a; --danger-dim: rgba(255,74,90,0.12);
      --success: #00e676; --success-dim: rgba(0,230,118,0.12);
      --amber: #ffd54f; --amber-dim: rgba(255,213,79,0.12);
      --shadow: 0 4px 30px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 10px 40px rgba(0, 0, 0, 0.6);
      --radius: 16px; --radius-sm: 8px;
    }
    html { font-size: 16px; }
    body { font-family: 'DM Sans', sans-serif; background: var(--surface); color: var(--ink); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .grid-bg {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: linear-gradient(rgba(255,255,255,0.007) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255,255,255,0.007) 1px, transparent 1px);
      background-size: 30px 30px;
      z-index: -2;
      pointer-events: none;
    }
    .glow-orb {
      position: fixed;
      width: 500px; height: 500px;
      background: radial-gradient(circle, rgba(81,81,255,0.06) 0%, transparent 70%);
      border-radius: 50%;
      top: -10%; right: -10%;
      z-index: -1;
      pointer-events: none;
      filter: blur(50px);
    }
    .topbar { position: sticky; top: 0; z-index: 100; background: rgba(8,8,16,0.75); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); padding: 0 2rem; height: 60px; display: flex; align-items: center; justify-content: space-between; }
    .topbar-brand { display: flex; align-items: center; gap: 10px; font-family: 'Syne', sans-serif; font-weight: 800; font-size: 1.1rem; color: var(--ink); }
    .brand-icon { width: 30px; height: 30px; background: var(--ink); color: #080810; border-radius: 8px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 10px rgba(255,255,255,0.25); }
    .brand-icon svg { color: #080810; }
    .topbar-meta { font-family: 'DM Mono', monospace; font-size: 0.72rem; color: var(--ink3); letter-spacing: 0.04em; }
    .page { max-width: 900px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; position: relative; z-index: 10; }
    .hero { margin-bottom: 2.5rem; }
    .hero-label { font-family: 'DM Mono', monospace; font-size: 0.7rem; letter-spacing: 0.12em; color: var(--ink3); text-transform: uppercase; margin-bottom: 0.5rem; }
    .hero-title { font-family: 'Syne', sans-serif; font-size: 2.2rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1.15; }
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 2rem; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.25rem; box-shadow: var(--shadow); backdrop-filter: blur(10px); }
    .stat-label { font-size: 0.72rem; font-family: 'DM Mono', monospace; letter-spacing: 0.06em; color: var(--ink3); text-transform: uppercase; margin-bottom: 0.4rem; }
    .stat-value { font-family: 'Syne', sans-serif; font-size: 1.7rem; font-weight: 700; line-height: 1; }
    .stat-value.accent { color: var(--accent-text); }
    .panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 1.5rem; overflow: hidden; backdrop-filter: blur(10px); }
    .panel-header { padding: 1.1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .panel-title { font-family: 'Syne', sans-serif; font-size: 0.95rem; font-weight: 700; }
    .panel-body { padding: 1.5rem; }
    
    .tabs-bar { display: flex; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 1px; margin-bottom: 1.5rem; }
    .tab-btn { background: transparent; border: none; color: var(--ink3); font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.85rem; padding: 10px 18px; cursor: pointer; border-radius: var(--radius-sm) var(--radius-sm) 0 0; transition: all 0.2s ease; position: relative; outline: none; }
    .tab-btn:hover { color: var(--ink); background: var(--card-hover); }
    .tab-btn.active { color: #ffffff; background: var(--accent-dim); }
    .tab-btn.active::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: var(--accent); border-radius: 3px 3px 0 0; }

    .chk-container { display: inline-flex; align-items: center; cursor: pointer; user-select: none; }
    .chk-container input { display: none; }
    .chk-checkmark { width: 18px; height: 18px; border: 1px solid var(--border-strong); border-radius: 4px; background: rgba(0,0,0,0.3); display: inline-block; position: relative; transition: all 0.15s ease; }
    .chk-container:hover .chk-checkmark { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(81,81,255,0.2); }
    .chk-container input:checked + .chk-checkmark { background: var(--accent); border-color: var(--accent); }
    .chk-container input:checked + .chk-checkmark::after { content: ''; position: absolute; left: 6px; top: 2px; width: 4px; height: 9px; border: solid #ffffff; border-width: 0 2px 2px 0; transform: rotate(45deg); }

    .bulk-drawer { position: fixed; bottom: -100px; left: 50%; transform: translateX(-50%); background: rgba(15,15,30,0.9); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); border: 1px solid var(--border-strong); border-radius: 30px; padding: 12px 24px; display: flex; align-items: center; gap: 16px; box-shadow: var(--shadow-lg); z-index: 1000; transition: bottom 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
    .bulk-drawer.active { bottom: 24px; }
    .bulk-text { font-size: 0.82rem; font-family: 'DM Mono', monospace; color: var(--ink2); }
    .btn-bulk-delete { background: var(--danger); color: #fff; border: none; border-radius: 20px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.78rem; padding: 8px 16px; cursor: pointer; transition: transform 0.12s, background 0.15s; }
    .btn-bulk-delete:hover { background: #ff2a3a; transform: translateY(-1px); }
    .btn-bulk-delete:active { transform: translateY(0); }

    .dotted-add-card { border: 2px dashed var(--border-strong); border-radius: var(--radius); padding: 1.5rem; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; background: transparent; transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1); margin-top: 1.5rem; min-height: 80px; position: relative; overflow: hidden; }
    .dotted-add-card:hover, .dotted-add-card.expanded { border-style: solid; border-color: var(--accent); background: var(--card); cursor: default; }
    .dotted-add-card .placeholder-content { display: flex; align-items: center; gap: 10px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.95rem; color: var(--ink3); transition: opacity 0.2s ease; }
    .dotted-add-card:hover .placeholder-content, .dotted-add-card.expanded .placeholder-content { opacity: 0; pointer-events: none; position: absolute; }
    .dotted-add-card .form-content { width: 100%; opacity: 0; pointer-events: none; display: none; transition: opacity 0.3s ease; }
    .dotted-add-card:hover .form-content, .dotted-add-card.expanded .form-content { display: block; opacity: 1; pointer-events: auto; }
    .dotted-add-card .form-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; width: 100%; }
    .dotted-add-card .bucket-type-row { display: flex; gap: 16px; margin-bottom: 12px; align-items: center; }
    .bucket-type-row span { font-size: 0.72rem; font-family: 'DM Mono', monospace; color: var(--ink3); text-transform: uppercase; }
    .bucket-radio { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; cursor: pointer; color: var(--ink2); }
    .bucket-radio input { accent-color: var(--accent); }

    .form-grid { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; }
    .field label { display: block; font-size: 0.75rem; font-weight: 500; color: var(--ink2); margin-bottom: 6px; }
    .field input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); font-family: 'DM Sans', sans-serif; font-size: 0.875rem; color: var(--ink); background: rgba(0,0,0,0.3); outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; }
    .field input:focus { border-color: var(--accent); background: rgba(0,0,0,0.5); box-shadow: 0 0 0 3px rgba(81,81,255,0.25); }
    .field input::placeholder { color: var(--ink3); }
    .btn { height: 40px; padding: 0 20px; border: none; border-radius: var(--radius-sm); font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.82rem; cursor: pointer; transition: transform 0.12s, opacity 0.15s; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .btn-primary { background: #ffffff; color: #080810; box-shadow: 0 4px 12px rgba(255,255,255,0.15); }
    .btn-primary:hover:not(:disabled) { background: #e8e8ff; }
    .btn-danger { background: var(--danger-dim); color: var(--danger); border: 1px solid rgba(255,74,90,0.18); padding: 0 12px; height: 32px; font-size: 0.77rem; border-radius: 6px; }
    .btn-danger:hover:not(:disabled) { background: rgba(255,74,90,0.22); }
    #toast-container { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
    .toast { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: var(--radius); font-size: 0.85rem; font-weight: 500; box-shadow: var(--shadow-lg); border: 1px solid var(--border); min-width: 240px; animation: slideIn 0.25s ease; background: rgba(15,15,30,0.85); backdrop-filter: blur(10px); }
    .toast.success { border-left: 3px solid var(--success); }
    .toast.error { border-left: 3px solid var(--danger); }
    .toast-icon { font-size: 1rem; }
    .toast.success .toast-icon { color: var(--success); }
    .toast.error .toast-icon { color: var(--danger); }
    @keyframes slideIn { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
    @keyframes fadeOut { to { opacity:0; transform:translateX(10px); } }
    .doc-table-wrap { overflow-x: auto; }
    .doc-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .doc-table th { font-family: 'DM Mono', monospace; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink3); padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.15); }
    .doc-table td { padding: 1rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .doc-table tbody tr { transition: background 0.1s; }
    .doc-table tbody tr:hover { background: rgba(255,255,255,0.015); }
    .doc-table tbody tr:last-child td { border-bottom: none; }
    .doc-name { font-weight: 500; display: flex; align-items: center; gap: 8px; }
    .doc-icon { width: 28px; height: 28px; background: var(--accent-dim); border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 0.7rem; font-family: 'DM Mono', monospace; color: var(--accent-text); font-weight: 600; text-transform: uppercase; }
    .doc-icon.secure { background: rgba(255,213,79,0.12); color: #ffd54f; }
    .doc-link-cell a { font-family: 'DM Mono', monospace; font-size: 0.75rem; color: var(--accent-text); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
    .doc-link-cell a:hover { text-decoration: underline; }
    .doc-id { font-family: 'DM Mono', monospace; font-size: 0.68rem; color: var(--ink3); }
    .state-box { padding: 3rem 1rem; text-align: center; }
    .state-box-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.25; }
    .state-box-title { font-family: 'Syne', sans-serif; font-size: 0.95rem; font-weight: 600; color: var(--ink2); margin-bottom: 0.25rem; }
    .state-box-sub { font-size: 0.8rem; color: var(--ink3); }
    .skeleton-row td { padding: 1rem; border-bottom: 1px solid var(--border); }
    .skel { height: 14px; border-radius: 4px; background: linear-gradient(90deg, var(--border) 25%, rgba(255,255,255,0.1) 50%, var(--border) 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 0.68rem; font-family: 'DM Mono', monospace; letter-spacing: 0.04em; }
    .badge-success { background: var(--success-dim); color: var(--success); }
    .badge-amber { background: var(--amber-dim); color: var(--amber); }
    .search-wrap { position: relative; }
    .search-wrap svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--ink3); pointer-events: none; }
    #searchInput { height: 36px; padding: 0 12px 0 34px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); font-family: 'DM Sans', sans-serif; font-size: 0.82rem; color: var(--ink); background: rgba(0,0,0,0.2); outline: none; width: 200px; transition: border-color 0.15s, width 0.2s ease; }
    #searchInput:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(81,81,255,0.15); width: 260px; background: rgba(0,0,0,0.4); }

    .secure-value-wrap { display: flex; align-items: center; gap: 8px; }
    .eye-btn { background: transparent; border: none; color: var(--ink3); cursor: pointer; font-size: 0.9rem; padding: 2px 6px; border-radius: 4px; transition: all 0.15s; outline: none; }
    .eye-btn:hover { color: var(--ink); background: var(--card-hover); }

    @media (max-width: 640px) {
      .form-grid { grid-template-columns: 1fr; }
      .stats-row { grid-template-columns: 1fr; }
      .hero-title { font-size: 1.6rem; }
      .topbar { padding: 0 1rem; }
      .page { padding: 1.5rem 1rem 4rem; }
      .dotted-add-card .form-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<div class="grid-bg"></div>
<div class="glow-orb"></div>

<div id="toast-container"></div>

<div class="topbar">
  <div class="topbar-brand">
    <div class="brand-icon">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
    Vault
  </div>
  <div style="display: flex; align-items: center; gap: 15px;">
    <span class="topbar-meta" id="vaultTime">—</span>
    <button onclick="handleLogout()" class="btn" style="height: 28px; padding: 0 10px; font-size: 0.72rem; background: var(--danger-dim); color: var(--danger); border: 1px solid rgba(255,74,90,0.15); border-radius: 4px; font-family: 'Syne', sans-serif;">Logout</button>
  </div>
</div>

<div class="page">
  <div class="hero">
    <p class="hero-label">Secure Document Store</p>
    <h1 class="hero-title">Your documents,<br>locked &amp; organised.</h1>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <p class="stat-label">Total Entries</p>
      <p class="stat-value accent" id="statTotal">—</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Status</p>
      <p class="stat-value" style="font-size:1rem;padding-top:4px;">
        <span class="badge badge-success" id="statStatus">● Online</span>
      </p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Last Sync</p>
      <p class="stat-value" style="font-size:0.88rem;font-family:'DM Mono',monospace;padding-top:6px;color:var(--ink2);" id="statUpdated">—</p>
    </div>
  </div>

  <div class="tabs-bar">
    <button class="tab-btn active" id="tab-vault" onclick="switchTab('vault')">Documents Vault</button>
    <button class="tab-btn" id="tab-buckets" onclick="switchTab('buckets')">Buckets</button>
    <button class="tab-btn" id="tab-personal" onclick="switchTab('personal')">Personal Info</button>
  </div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title" id="tablePanelTitle">Documents</span>
      <div class="search-wrap">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="searchInput" placeholder="Filter current view…" oninput="renderTable()">
      </div>
    </div>
    <div class="doc-table-wrap">
      <table class="doc-table">
        <thead id="docTableHeader">
          <tr>
            <th style="width: 40px;">
              <label class="chk-container">
                <input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)">
                <span class="chk-checkmark"></span>
              </label>
            </th>
            <th>Name</th><th>Link</th><th>ID</th><th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody id="docTableBody">
          <tr class="skeleton-row"><td></td><td><div class="skel" style="width:60%"></div></td><td><div class="skel" style="width:80%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
          <tr class="skeleton-row"><td></td><td><div class="skel" style="width:45%"></div></td><td><div class="skel" style="width:70%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
          <tr class="skeleton-row"><td></td><td><div class="skel" style="width:55%"></div></td><td><div class="skel" style="width:60%"></div></td><td><div class="skel" style="width:90%"></div></td><td></td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="dotted-add-card" id="dottedAddCard">
    <div class="placeholder-content">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>Scroll to bottom &amp; hover to add new entry</span>
    </div>
    <div class="form-content">
      <div class="bucket-type-row" id="bucketTypeSelectorRow" style="display: none;">
        <span>Select Bucket:</span>
        <label class="bucket-radio">
          <input type="radio" name="bucketType" value="coding_bucket" checked>
          💻 Coding
        </label>
        <label class="bucket-radio">
          <input type="radio" name="bucketType" value="movie_bucket">
          🎬 Movie
        </label>
      </div>
      <div class="form-row">
        <div class="field">
          <label id="addNameLabel" for="addName">Document Name</label>
          <input type="text" id="addName" placeholder="e.g. Aadhaar Card">
        </div>
        <div class="field">
          <label id="addValueLabel" for="addValue">Secure Link</label>
          <input type="text" id="addValue" placeholder="https://drive.google.com/…">
        </div>
        <button class="btn btn-primary" id="addSaveBtn" onclick="addEntryFromDottedCard()">Save Entry</button>
      </div>
    </div>
  </div>

  <div class="bulk-drawer" id="bulkDrawer">
    <span class="bulk-text"><span id="bulkCount">0</span> selected</span>
    <button class="btn-bulk-delete" id="bulkDeleteBtn" onclick="deleteBulkSelected()">Delete Selected</button>
    <button onclick="selectedIds=[];document.querySelectorAll('.item-chk').forEach(c=>c.checked=false);document.getElementById('selectAll').checked=false;updateBulkDrawer();" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:1rem;padding:4px;">✕</button>
  </div>

</div>

<script>
// ═══════════════════════════════════════════════════════════
// CLIENT-SIDE LOGGER
// All logs appear in the browser developer console (F12)
// ═══════════════════════════════════════════════════════════
function dbg(level, section, msg, data) {
  const consoleMsg = '[VAULT][' + section + '] ' + msg;
  if (level === 'ERR') console.error(consoleMsg, data !== undefined ? data : '');
  else if (level === 'WARN') console.warn(consoleMsg, data !== undefined ? data : '');
  else console.log(consoleMsg, data !== undefined ? data : '');
}

// ── GLOBAL ERROR CATCHERS ──────────────────────────────────
window.addEventListener('error', function(e) {
  dbg('ERR', 'GLOBAL', 'Uncaught JS error: ' + e.message, {
    file: e.filename, line: e.lineno, col: e.colno
  });
});
window.addEventListener('unhandledrejection', function(e) {
  const reason = e.reason;
  dbg('ERR', 'PROMISE', 'Unhandled rejection: ' + (reason ? (reason.message || String(reason)) : 'unknown'));
});

// ══════════════════════════════════════════════════════════
// APP STATE
// ══════════════════════════════════════════════════════════
let allDocs = [];
let allLists = [];
let activeTab = 'vault'; // 'vault', 'buckets', 'personal'
let selectedIds = [];
let isInputFocused = false;

function safeText(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

function initials(name) {
  if (!name || typeof name !== 'string') return '?';
  const parts = name.trim().split(/\\s+/).slice(0, 2);
  return parts.map(w => w && w[0] ? w[0].toUpperCase() : '').join('');
}

function toast(msg, type = 'success') {
  dbg('INFO', 'TOAST', msg + ' [type=' + type + ']');
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
  dbg('INFO', 'STATS', 'Updating stats for active tab=' + activeTab);
  let total = 0;
  if (activeTab === 'vault') {
    total = allDocs.filter(d => (d.link || '').startsWith('http')).length;
  } else if (activeTab === 'personal') {
    total = allDocs.filter(d => !(d.link || '').startsWith('http')).length;
  } else if (activeTab === 'buckets') {
    total = allLists.length;
  }
  document.getElementById('statTotal').textContent = total;
  const now = new Date();
  document.getElementById('statUpdated').textContent =
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function handleLogout() {
  if (!confirm('Log out from Vault?')) return;
  try {
    const res = await fetch('/vault/logout', { method: 'POST' });
    if (res.ok) window.location.reload();
  } catch (err) {
    toast('Logout failed: ' + err.message, 'error');
  }
}

// ── TABS LOGIC ─────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  dbg('INFO', 'TAB', 'Switching to tab: ' + tab);

  // Sync tab active states
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById('tab-' + tab).classList.add('active');

  // Update header text based on active tab
  document.getElementById('tablePanelTitle').textContent = 
    tab === 'vault' ? 'Secure Documents' : tab === 'personal' ? 'Personal Info (Text)' : 'Buckets & Lists';

  // Clear selections
  selectedIds = [];
  const selectAllChk = document.getElementById('selectAll');
  if (selectAllChk) selectAllChk.checked = false;
  updateBulkDrawer();

  // Refresh add card fields based on tab
  updateAddCardFields();

  // Render stats & table
  updateStats();
  renderTable();
}

function updateAddCardFields() {
  const card = document.getElementById('dottedAddCard');
  if (!card) return;

  const bucketSelectRow = document.getElementById('bucketTypeSelectorRow');
  const nameLabel = document.getElementById('addNameLabel');
  const nameInput = document.getElementById('addName');
  const valueLabel = document.getElementById('addValueLabel');
  const valueInput = document.getElementById('addValue');

  if (activeTab === 'buckets') {
    bucketSelectRow.style.display = 'flex';
    nameLabel.textContent = 'Bucket Title';
    nameInput.placeholder = 'e.g. Learn LlamaIndex';
    valueLabel.textContent = 'Link or Notes';
    valueInput.placeholder = 'e.g. https://github.com/run-llama/LlamaIndex';
  } else if (activeTab === 'personal') {
    bucketSelectRow.style.display = 'none';
    nameLabel.textContent = 'Credential / Secret Title';
    nameInput.placeholder = 'e.g. Email Password';
    valueLabel.textContent = 'Value / Password';
    valueInput.placeholder = 'e.g. mySecret123!';
  } else { // 'vault'
    bucketSelectRow.style.display = 'none';
    nameLabel.textContent = 'Document Name';
    nameInput.placeholder = 'e.g. Aadhaar Card';
    valueLabel.textContent = 'Secure Link';
    valueInput.placeholder = 'https://drive.google.com/…';
  }
}

// ── CHECKBOX AND BULK ACTIONS ──────────────────────────────
function toggleItemSelect(id, chk) {
  if (chk.checked) {
    if (!selectedIds.includes(id)) selectedIds.push(id);
  } else {
    selectedIds = selectedIds.filter(x => x !== id);
  }

  // Sync selectAll master state
  const chks = document.querySelectorAll('.item-chk');
  const allChecked = chks.length > 0 && Array.from(chks).every(c => c.checked);
  document.getElementById('selectAll').checked = allChecked;

  updateBulkDrawer();
}

function toggleSelectAll(masterChk) {
  const chks = document.querySelectorAll('.item-chk');
  chks.forEach(chk => {
    chk.checked = masterChk.checked;
    const id = chk.getAttribute('data-id');
    if (masterChk.checked) {
      if (!selectedIds.includes(id)) selectedIds.push(id);
    } else {
      selectedIds = selectedIds.filter(x => x !== id);
    }
  });

  updateBulkDrawer();
}

function updateBulkDrawer() {
  const drawer = document.getElementById('bulkDrawer');
  const countSpan = document.getElementById('bulkCount');
  if (!drawer || !countSpan) return;

  if (selectedIds.length > 0) {
    countSpan.textContent = selectedIds.length;
    drawer.classList.add('active');
  } else {
    drawer.classList.remove('active');
  }
}

async function deleteBulkSelected() {
  if (selectedIds.length === 0) return;
  if (!confirm('Delete all ' + selectedIds.length + ' selected entries? This cannot be undone.')) return;

  const btn = document.getElementById('bulkDeleteBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  const type = activeTab === 'buckets' ? 'list' : 'vault';
  dbg('NET', 'BULK-DELETE', 'Starting bulk delete of ' + selectedIds.length + ' entries of type ' + type);

  try {
    const res = await fetch('/vault/api/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds, type })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Bulk deletion failed.');
    }

    toast('Successfully deleted ' + selectedIds.length + ' entries.');
    
    // Remove local values
    if (activeTab === 'buckets') {
      allLists = allLists.filter(x => !selectedIds.includes(x.entryId));
    } else {
      allDocs = allDocs.filter(x => !selectedIds.includes(x.docId));
    }

    selectedIds = [];
    updateBulkDrawer();
    updateStats();
    renderTable();

  } catch (err) {
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete Selected';
  }
}

// ── EYE SECRET VISIBILITY ──────────────────────────────────
function toggleSecretVisibility(btn) {
  const wrap = btn.closest('.secure-value-wrap');
  const masked = wrap.querySelector('.secure-value.masked');
  const plain = wrap.querySelector('.secure-value.plain');
  if (masked.style.display === 'none') {
    masked.style.display = 'inline';
    plain.style.display = 'none';
    btn.textContent = '👁';
  } else {
    masked.style.display = 'none';
    plain.style.display = 'inline';
    btn.textContent = '🙈';
  }
}

// ── RENDER TABLE ───────────────────────────────────────────
function renderTable() {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  dbg('INFO', 'RENDER', 'renderTable() called, query="' + query + '"');

  const tbody = document.getElementById('docTableBody');
  if (!tbody) return;

  // 1. Get filtered list of items based on activeTab
  let items = [];
  if (activeTab === 'vault') {
    items = allDocs.filter(d => {
      const link = d.link || '';
      return link.startsWith('http://') || link.startsWith('https://');
    });
  } else if (activeTab === 'personal') {
    items = allDocs.filter(d => {
      const link = d.link || '';
      return !link.startsWith('http://') && !link.startsWith('https://');
    });
  } else if (activeTab === 'buckets') {
    items = allLists;
  }

  // 2. Filter by search query
  if (query) {
    items = items.filter(item => {
      const name = (item.name || item.title || '').toLowerCase();
      const val = (item.link || item.metadata?.rawUrl || '').toLowerCase();
      return name.includes(query) || val.includes(query);
    });
  }

  // Update master selectAll sync
  const selectAllChk = document.getElementById('selectAll');
  if (selectAllChk) {
    const allChecked = items.length > 0 && items.every(item => selectedIds.includes(item.docId || item.entryId));
    selectAllChk.checked = allChecked;
  }

  // 3. Render table headers based on activeTab
  const thead = document.getElementById('docTableHeader');
  if (thead) {
    if (activeTab === 'buckets') {
      thead.innerHTML = '<tr>' +
        '<th style="width: 40px;">' +
          '<label class="chk-container">' +
            '<input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)">' +
            '<span class="chk-checkmark"></span>' +
          '</label>' +
        '</th>' +
        '<th>Title</th>' +
        '<th>Bucket</th>' +
        '<th>Link / Notes</th>' +
        '<th style="text-align: right;">Action</th>' +
      '</tr>';
    } else if (activeTab === 'personal') {
      thead.innerHTML = '<tr>' +
        '<th style="width: 40px;">' +
          '<label class="chk-container">' +
            '<input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)">' +
            '<span class="chk-checkmark"></span>' +
          '</label>' +
        '</th>' +
        '<th>Credential Name</th>' +
        '<th>Value / Password</th>' +
        '<th>ID</th>' +
        '<th style="text-align: right;">Action</th>' +
      '</tr>';
    } else { // 'vault'
      thead.innerHTML = '<tr>' +
        '<th style="width: 40px;">' +
          '<label class="chk-container">' +
            '<input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)">' +
            '<span class="chk-checkmark"></span>' +
          '</label>' +
        '</th>' +
        '<th>Name</th>' +
        '<th>Link</th>' +
        '<th>ID</th>' +
        '<th style="text-align: right;">Action</th>' +
      '</tr>';
    }
  }

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="state-box">' +
      '<div class="state-box-icon">🗂</div>' +
      '<p class="state-box-title">' + (query ? 'No results' : 'No documents yet') + '</p>' +
      '<p class="state-box-sub">' + (query ? 'Try a different search term.' : 'Use the box below to add your first entry.') + '</p>' +
      '</div></td></tr>';
    return;
  }

  try {
    const rows = items.map(item => {
      const id = item.docId || item.entryId;
      const isChecked = selectedIds.includes(id) ? 'checked' : '';

      if (activeTab === 'buckets') {
        const title = safeText(item.title || '(no title)');
        const link = safeText(item.metadata?.rawUrl || '');
        const bType = item.listType === 'movie_bucket' ? '🎬 Movie' : '💻 Coding';
        const bClass = item.listType === 'movie_bucket' ? 'badge-amber' : 'badge-success';
        const abbr = initials(item.title || '');

        return '<tr>' +
          '<td>' +
            '<label class="chk-container">' +
              '<input type="checkbox" class="item-chk" data-id="' + id + '" ' + isChecked + ' onchange="toggleItemSelect(\'' + id + '\', this)">' +
              '<span class="chk-checkmark"></span>' +
            '</label>' +
          '</td>' +
          '<td><div class="doc-name"><div class="doc-icon">' + safeText(abbr) + '</div>' + title + '</div></td>' +
          '<td><span class="badge ' + bClass + '">' + bType + '</span></td>' +
          '<td class="doc-link-cell">' +
            (link ? '<a href="' + link + '" target="_blank" rel="noopener noreferrer">Open Link<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>' : '<span class="doc-id">None</span>') +
          '</td>' +
          '<td style="text-align: right;"><button class="btn btn-danger" onclick="deleteItem(\'' + id + '\', this)">Remove</button></td>' +
        '</tr>';
      } else if (activeTab === 'personal') {
        const title = safeText(item.name || '(no name)');
        const secret = safeText(item.link || '');
        const abbr = initials(item.name || '');

        return '<tr>' +
          '<td>' +
            '<label class="chk-container">' +
              '<input type="checkbox" class="item-chk" data-id="' + id + '" ' + isChecked + ' onchange="toggleItemSelect(\'' + id + '\', this)">' +
              '<span class="chk-checkmark"></span>' +
            '</label>' +
          '</td>' +
          '<td><div class="doc-name"><div class="doc-icon secure">' + safeText(abbr) + '</div>' + title + '</div></td>' +
          '<td>' +
            '<div class="secure-value-wrap">' +
              '<span class="secure-value masked">••••••••</span>' +
              '<span class="secure-value plain" style="display: none; font-family: \'DM Mono\', monospace;">' + secret + '</span>' +
              '<button class="eye-btn" onclick="toggleSecretVisibility(this)" title="Toggle Visibility">👁</button>' +
            '</div>' +
          '</td>' +
          '<td><span class="doc-id">' + id.slice(0, 8) + '…</span></td>' +
          '<td style="text-align: right;"><button class="btn btn-danger" onclick="deleteItem(\'' + id + '\', this)">Remove</button></td>' +
        '</tr>';
      } else { // 'vault'
        const name = safeText(item.name || '(no name)');
        const link = safeText(item.link || '');
        const abbr = initials(item.name || '');

        let hostLabel = 'Open';
        try {
          hostLabel = new URL(item.link).hostname.replace('www.', '').split('.')[0];
        } catch {
          hostLabel = 'Open';
        }

        return '<tr>' +
          '<td>' +
            '<label class="chk-container">' +
              '<input type="checkbox" class="item-chk" data-id="' + id + '" ' + isChecked + ' onchange="toggleItemSelect(\'' + id + '\', this)">' +
              '<span class="chk-checkmark"></span>' +
            '</label>' +
          '</td>' +
          '<td><div class="doc-name"><div class="doc-icon">' + safeText(abbr) + '</div>' + name + '</div></td>' +
          '<td class="doc-link-cell">' +
            '<a href="' + link + '" target="_blank" rel="noopener noreferrer">' +
              safeText(hostLabel) +
              '<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
            '</a>' +
          '</td>' +
          '<td><span class="doc-id">' + id.slice(0, 8) + '…</span></td>' +
          '<td style="text-align: right;"><button class="btn btn-danger" onclick="deleteItem(\'' + id + '\', this)">Remove</button></td>' +
        '</tr>';
      }
    });

    tbody.innerHTML = rows.join('');
  } catch(renderErr) {
    dbg('ERR', 'RENDER', 'Exception during row building: ' + renderErr.message, renderErr.stack);
  }
}

// ── FETCH DOCS ─────────────────────────────────────────────
async function fetchDocs() {
  const url = '/vault/api?_t=' + Date.now();
  dbg('NET', 'FETCH', 'Starting GET ' + url);

  try {
    const fetchStart = performance.now();
    const res = await fetch(url, { credentials: 'same-origin' });
    const fetchMs = (performance.now() - fetchStart).toFixed(0);

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable body)');
      throw new Error('HTTP ' + res.status + ' — ' + errText.slice(0, 120));
    }

    const rawText = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (jsonErr) {
      throw new Error('Invalid JSON from /vault/api: ' + jsonErr.message);
    }

    allDocs = parsed.docs || [];
    allLists = parsed.lists || [];

    dbg('INFO', 'FETCH', 'Data loaded, docs count=' + allDocs.length + ', lists count=' + allLists.length);

    updateStats();
    renderTable();

    document.getElementById('statStatus').className = 'badge badge-success';
    document.getElementById('statStatus').textContent = '● Online';

  } catch (err) {
    dbg('ERR', 'FETCH', 'fetchDocs FAILED: ' + err.message);
    document.getElementById('statStatus').className = 'badge badge-amber';
    document.getElementById('statStatus').textContent = '● Degraded';
    document.getElementById('docTableBody').innerHTML =
      '<tr><td colspan="5"><div class="state-box">' +
      '<div class="state-box-icon">⚠</div>' +
      '<p class="state-box-title">Could not load documents</p>' +
      '<p class="state-box-sub">' + safeText(err.message) + '</p>' +
      '</div></td></tr>';
  }
}

// ── HOVER-TO-ADD DOTTED CARD ACTION ────────────────────────
async function addEntryFromDottedCard() {
  const nameEl = document.getElementById('addName');
  const valEl = document.getElementById('addValue');
  const btn = document.getElementById('addSaveBtn');
  if (!nameEl || !valEl || !btn) return;

  const name = nameEl.value.trim();
  const link = valEl.value.trim();

  if (!name) {
    toast('Name/Title is required.', 'error');
    nameEl.focus();
    return;
  }
  if (!link) {
    toast('Link/Content/Secret is required.', 'error');
    valEl.focus();
    return;
  }

  // If we are on Documents Vault, check for URL
  if (activeTab === 'vault') {
    try {
      new URL(link);
    } catch (urlErr) {
      toast('Please enter a valid URL.', 'error');
      valEl.focus();
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  let bucketType = 'coding_bucket';
  if (activeTab === 'buckets') {
    const selectedRadio = document.querySelector('input[name="bucketType"]:checked');
    if (selectedRadio) {
      bucketType = selectedRadio.value;
    }
  }

  const payload = {
    name,
    link,
    type: activeTab === 'buckets' ? 'list' : 'vault',
    listType: activeTab === 'buckets' ? bucketType : undefined
  };

  dbg('NET', 'ADD', 'POSTing payload to /vault/api', payload);

  try {
    const res = await fetch('/vault/api?_t=' + Date.now(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Failed to save entry.');
    }

    const resData = await res.json();
    if (!resData.doc) {
      throw new Error('Save succeeded but no data returned.');
    }

    if (activeTab === 'buckets') {
      allLists.unshift(resData.doc);
    } else {
      allDocs.unshift(resData.doc);
    }

    // Clear inputs and collapse card
    nameEl.value = '';
    valEl.value = '';
    
    const card = document.getElementById('dottedAddCard');
    if (card) card.classList.remove('expanded');

    toast('Entry saved securely.');
    updateStats();
    renderTable();

  } catch (err) {
    dbg('ERR', 'ADD', 'addEntry FAILED: ' + err.message);
    toast('Failed to save: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Entry';
  }
}

// ── DELETE INDIVIDUAL ITEM ─────────────────────────────────
async function deleteItem(id, btnEl) {
  dbg('INFO', 'DELETE', 'deleteItem() called, id=' + id);

  if (!id) {
    toast('Cannot delete: missing ID.', 'error');
    return;
  }

  if (!confirm('Delete this entry? This cannot be undone.')) {
    return;
  }

  btnEl.disabled = true;
  btnEl.textContent = '…';

  const type = activeTab === 'buckets' ? 'list' : 'vault';
  const url = '/vault/api/' + encodeURIComponent(id) + '?type=' + type;
  dbg('NET', 'DELETE', 'DELETE ' + url);

  try {
    const start = performance.now();
    const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
    const ms = (performance.now() - start).toFixed(0);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error('HTTP ' + res.status + ' — ' + errText.slice(0, 80));
    }

    if (activeTab === 'buckets') {
      allLists = allLists.filter(x => x.entryId !== id);
    } else {
      allDocs = allDocs.filter(x => x.docId !== id);
    }

    // Remove from selected list if checked
    selectedIds = selectedIds.filter(x => x !== id);
    updateBulkDrawer();

    updateStats();
    renderTable();
    toast('Entry removed.');

  } catch (err) {
    dbg('ERR', 'DELETE', 'deleteItem FAILED: ' + err.message);
    toast('Delete failed: ' + err.message, 'error');
    btnEl.disabled = false;
    btnEl.textContent = 'Remove';
  }
}

// ── DOTTED CARD PERSISTENCE LOGIC ──────────────────────────
function setupDottedCardEvents() {
  const card = document.getElementById('dottedAddCard');
  if (!card) return;

  card.addEventListener('click', function(e) {
    // If not expanded and they clicked it, expand it
    if (!card.classList.contains('expanded')) {
      card.classList.add('expanded');
      const firstInput = card.querySelector('input');
      if (firstInput) firstInput.focus();
    }
  });

  const inputs = card.querySelectorAll('input, select');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      isInputFocused = true;
      card.classList.add('expanded');
    });
    input.addEventListener('blur', () => {
      isInputFocused = false;
      setTimeout(() => {
        if (!isInputFocused && !card.matches(':hover')) {
          card.classList.remove('expanded');
        }
      }, 150);
    });
  });

  card.addEventListener('mouseleave', () => {
    setTimeout(() => {
      if (!isInputFocused) {
        card.classList.remove('expanded');
      }
    }, 150);
  });
}

// ── INIT ───────────────────────────────────────────────────
function init() {
  dbg('INFO', 'INIT', '=== Vault Dashboard Initializing ===');

  try {
    const vaultTimeEl = document.getElementById('vaultTime');

    function tick() {
      if (vaultTimeEl) {
        vaultTimeEl.textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      }
    }
    tick();
    setInterval(tick, 10000);

    const spinStyle = document.createElement('style');
    spinStyle.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(spinStyle);

    // Initial setup of dotted card inputs
    setupDottedCardEvents();

    dbg('INFO', 'INIT', 'Calling fetchDocs()...');
    fetchDocs();

    dbg('INFO', 'INIT', '=== Init complete ===');

  } catch (err) {
    dbg('ERR', 'INIT', 'INIT CRASHED: ' + err.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;

      res.send(html);
      log('DASHBOARD', 'HTML sent successfully');
    } catch (err) {
      logErr('DASHBOARD', 'renderDashboard threw an exception', err);
      res.status(500).send('Dashboard render error — check server logs.');
    }
  }

  // ── GET DOCUMENTS ─────────────────────────────────────────────────────────
  private async getDocuments(_req: Request, res: Response) {
    log('GET', 'getDocuments() called');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    try {
      log('GET', 'Calling vaultRepo.findAll()...');
      const docs = await this.vaultRepo.findAll();

      log('GET', 'Calling user_lists query...');
      const lists = await this.vaultRepo.db.collection('user_lists')
        .find({ listType: { $in: ['coding_bucket', 'movie_bucket'] }, status: 'active' })
        .toArray();

      log('GET', `Sending unified docs (${docs.length}) and lists (${lists.length})`);
      res.json({ docs, lists });
    } catch (err) {
      logErr('GET', 'getDocuments threw an exception', err);
      res.status(500).json({ error: 'Failed to retrieve documents.' });
    }
  }

  // ── ADD DOCUMENT ──────────────────────────────────────────────────────────
  private async addDocument(req: Request, res: Response) {
    log('POST', 'addDocument() called');
    log('POST', 'req.body raw', req.body);

    const { name, link, type, listType } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      log('POST', '⚠ Validation FAIL: name missing or empty');
      return res.status(400).json({ error: 'Name is required.' });
    }

    if (!link || typeof link !== 'string' || link.trim().length === 0) {
      log('POST', '⚠ Validation FAIL: link missing or empty');
      return res.status(400).json({ error: 'Content/Link is required.' });
    }

    try {
      if (type === 'list') {
        // Save to user_lists collection
        const targetListType = (listType === 'movie_bucket' || listType === 'coding_bucket') ? listType : 'coding_bucket';
        
        // Find existing userId to align with
        let userId = 'default-user';
        const existingList = await this.vaultRepo.db.collection('user_lists').findOne({});
        if (existingList && existingList.userId) {
          userId = existingList.userId;
        }

        const entryId = randomUUID();
        const cleanTitle = name.trim();
        const urlRegex = /(https?:\/\/[^\s]+)/;
        const urlMatch = link.match(urlRegex);
        const rawUrl = urlMatch ? urlMatch[1] : link.trim();

        const newEntry = {
          entryId,
          userId,
          listType: targetListType,
          title: cleanTitle,
          status: 'active',
          tags: [targetListType],
          metadata: {
            rawUrl: rawUrl,
            notes: link.trim()
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        log('POST', `Saving list entry to user_lists: ${cleanTitle}`);
        await this.vaultRepo.db.collection('user_lists').insertOne(newEntry);
        log('POST', 'Saved successfully to user_lists');

        return res.json({ success: true, doc: newEntry });
      } else {
        // Save to user_vault collection
        const docId = randomUUID();
        const doc: DocumentVaultEntry = {
          docId,
          name: name.trim(),
          link: link.trim(),
          aliases: [name.trim().toLowerCase()]
        };

        log('POST', 'Calling vaultRepo.save(doc)...');
        await this.vaultRepo.save(doc);
        log('POST', 'vaultRepo.save() completed without error');

        return res.json({ success: true, doc });
      }
    } catch (err) {
      logErr('POST', 'addDocument threw an exception', err);
      res.status(500).json({ error: 'Failed to save entry.' });
    }
  }

  // ── DELETE DOCUMENT ───────────────────────────────────────────────────────
  private async deleteDocument(req: Request, res: Response) {
    log('DELETE', 'deleteDocument() called');
    log('DELETE', 'req.params', req.params);

    const id = req.params.id as string;
    const type = req.query.type as string;

    if (!id) {
      log('DELETE', '⚠ id is missing/empty — returning 400');
      return res.status(400).json({ error: 'Missing ID.' });
    }

    try {
      if (type === 'list') {
        log('DELETE', `Deleting entryId ${id} from user_lists...`);
        await this.vaultRepo.db.collection('user_lists').deleteOne({ entryId: id });
        log('DELETE', 'user_lists deletion completed OK');
      } else {
        log('DELETE', `Calling vaultRepo.delete(${id})...`);
        await this.vaultRepo.delete(id);
        log('DELETE', 'vaultRepo.delete() completed OK');
      }

      res.json({ success: true });
    } catch (err) {
      logErr('DELETE', 'deleteDocument threw an exception', err);
      res.status(500).json({ error: 'Failed to delete.' });
    }
  }

  // ── DELETE BULK ───────────────────────────────────────────────────────────
  private async deleteBulk(req: Request, res: Response) {
    log('DELETE-BULK', 'deleteBulk() called');
    const { ids, type } = req.body || {};

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      log('DELETE-BULK', '⚠ IDs array is missing/empty — returning 400');
      return res.status(400).json({ error: 'IDs array is required.' });
    }

    try {
      if (type === 'list') {
        log('DELETE-BULK', `Deleting ${ids.length} entries from user_lists...`);
        const result = await this.vaultRepo.db.collection('user_lists').deleteMany({
          entryId: { $in: ids }
        });
        log('DELETE-BULK', `Successfully deleted ${result.deletedCount} lists`);
        return res.json({ success: true, count: result.deletedCount });
      } else {
        log('DELETE-BULK', `Deleting ${ids.length} docs from user_vault...`);
        const result = await this.vaultRepo.db.collection('user_vault').deleteMany({
          docId: { $in: ids }
        });
        log('DELETE-BULK', `Successfully deleted ${result.deletedCount} docs`);
        return res.json({ success: true, count: result.deletedCount });
      }
    } catch (err) {
      logErr('DELETE-BULK', 'Bulk delete failed', err);
      return res.status(500).json({ error: 'Failed to perform bulk delete.' });
    }
  }
}