/**
 * Mock Data Loader
 * 
 * Loads mock data from JSON files with local override support:
 *   1. Checks for `backend/content/mock-data.local.json` (gitignored — enterprise data)
 *   2. Falls back to `backend/content/mock-data.json` (committed — generic dummy data)
 * 
 * This allows testing the agent flow with real schemas/table names locally
 * without pushing enterprise details to the OS repo.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadMockData() {
  const localPath = path.resolve(__dirname, '../content/mock-data.local.json');
  const defaultPath = path.resolve(__dirname, '../content/mock-data.json');

  let dataPath = defaultPath;
  if (fs.existsSync(localPath)) {
    dataPath = localPath;
    console.log('🧪 Agent mock data: using local override (mock-data.local.json)');
  } else {
    console.log('🧪 Agent mock data: using default (mock-data.json)');
  }

  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('⚠️  Failed to load mock data:', err.message);
    return { query_results: {}, plans: {}, synthesis: { summary: 'No mock data available.', artifacts: [] } };
  }
}

const mockData = loadMockData();

// Export in the same shape the routes.js expects
export const MOCK_QUERY_RESULTS = mockData.query_results || {};
export const MOCK_PLANS = mockData.plans || {};
export const MOCK_SYNTHESIS = mockData.synthesis || { summary: '', artifacts: [] };
