import { Request, Response, Router } from 'express';
import { DocumentVaultMongoRepository, DocumentVaultEntry } from '../../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
import { randomUUID } from 'crypto';

export class VaultController {
  public router: Router;

  constructor(private vaultRepo: DocumentVaultMongoRepository) {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Basic Auth Middleware
    this.router.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      const b64auth = (typeof authHeader === 'string' ? authHeader : '').split(' ')[1] || '';
      const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

      const validPassword = process.env.VAULT_PASSWORD || 'karenadmin123';
      
      if (login && password === validPassword) {
        return next();
      }

      res.set('WWW-Authenticate', 'Basic realm="401"');
      res.status(401).send('Authentication required.');
    });

    this.router.get('/', this.renderDashboard.bind(this));
    this.router.get('/api', this.getDocuments.bind(this));
    this.router.post('/api', this.addDocument.bind(this));
    this.router.delete('/api/:id', this.deleteDocument.bind(this));
  }

  private async renderDashboard(req: Request, res: Response) {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Karen Document Vault</title>
      <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --primary: #3b82f6; --danger: #ef4444; }
        body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 2rem; margin-bottom: 2rem; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .card { background: var(--card); border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .form-group { margin-bottom: 1rem; }
        label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: #94a3b8; }
        input { width: 100%; padding: 0.75rem; border-radius: 4px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
        button { background: var(--primary); color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; cursor: pointer; font-weight: bold; }
        button.danger { background: var(--danger); padding: 0.5rem 1rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #334155; }
        th { color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; }
        a { color: var(--primary); text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔒 Secure Document Vault</h1>
        
        <div class="card">
          <h3>Add New Document</h3>
          <form id="addForm">
            <div class="form-group">
              <label>Document Name (e.g., Aadhar Card)</label>
              <input type="text" id="docName" required>
            </div>
            <div class="form-group">
              <label>Secure Link (Google Drive, Dropbox, etc.)</label>
              <input type="url" id="docLink" required>
            </div>
            <button type="submit">+ Save to Vault</button>
          </form>
        </div>

        <div class="card">
          <h3>Stored Documents</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Link</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="docTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>

      <script>
        async function fetchDocs() {
          const res = await fetch('/vault/api');
          const docs = await res.json();
          const tbody = document.getElementById('docTableBody');
          tbody.innerHTML = docs.map(doc => \`
            <tr>
              <td><strong>\${doc.name}</strong></td>
              <td><a href="\${doc.link}" target="_blank">View Document</a></td>
              <td><button class="danger" onclick="deleteDoc('\${doc.docId}')">Delete</button></td>
            </tr>
          \`).join('');
        }

        document.getElementById('addForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = document.getElementById('docName').value;
          const link = document.getElementById('docLink').value;
          await fetch('/vault/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, link })
          });
          document.getElementById('addForm').reset();
          fetchDocs();
        });

        async function deleteDoc(id) {
          if(confirm('Are you sure you want to delete this document?')) {
            await fetch(\`/vault/api/\${id}\`, { method: 'DELETE' });
            fetchDocs();
          }
        }

        fetchDocs();
      </script>
    </body>
    </html>
    `;
    res.send(html);
  }

  private async getDocuments(req: Request, res: Response) {
    const docs = await this.vaultRepo.findAll();
    res.json(docs);
  }

  private async addDocument(req: Request, res: Response) {
    const { name, link } = req.body;
    if (!name || !link) return res.status(400).json({ error: 'Missing name or link' });
    
    const doc: DocumentVaultEntry = {
      docId: randomUUID(),
      name,
      link,
      aliases: [name.toLowerCase()]
    };

    await this.vaultRepo.save(doc);
    res.json({ success: true, doc });
  }

  private async deleteDocument(req: Request, res: Response) {
    const id = req.params.id as string;
    await this.vaultRepo.delete(id);
    res.json({ success: true });
  }
}
