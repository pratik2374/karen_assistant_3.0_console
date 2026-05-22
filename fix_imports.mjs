import fs from 'fs';
import path from 'path';

function fixImports(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      fixImports(fullPath);
    } else if (fullPath.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // Look for relative imports like: import { X } from './something';
      // Or: export { Y } from '../elsewhere';
      // Ignore packages like 'express' or 'chalk' (they don't start with .)
      const importExportRegex = /((?:import|export)\s+.*?from\s+['"])((\.\/|\.\.\/).*?)(['"])/g;
      
      let modified = false;
      content = content.replace(importExportRegex, (match, p1, p2, p3, p4) => {
        // If it doesn't already have an extension
        if (!p2.endsWith('.js') && !p2.endsWith('.json') && !p2.endsWith('.ts')) {
          modified = true;
          return `${p1}${p2}.js${p4}`;
        }
        return match;
      });

      if (modified) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Fixed imports in ${fullPath}`);
      }
    }
  }
}

fixImports('./src');
console.log('Done fixing imports!');
