import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Creates a DB connection and applies schema.sql.
 * Pass ':memory:' in tests for a fresh, isolated DB per test.
 */
export function createDb(filename = 'data.sqlite') {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
