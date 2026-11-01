import { getDatabase } from "./index";
import type { photoSeries } from "./schema";
import { defaultSeries as defaults } from "./default-series";

export type SeriesRow = typeof photoSeries.$inferSelect;

export async function initializeSeries() {
  const database = getDatabase();
  const statements = defaults.map(series => database.prepare(`INSERT INTO series (id, name, description, sort_order, created_at)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'series_initialized')`)
    .bind(series.id, series.name, series.description, series.sortOrder, new Date().toISOString()));
  statements.push(database.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('series_initialized', '1')"));
  await database.batch(statements);
}

export async function getSeries() {
  const database = getDatabase();
  const initialized = await database.prepare("SELECT value FROM settings WHERE key = 'series_initialized'").first();
  if (!initialized) return defaults;
  const result = await database.prepare("SELECT id, name, description, sort_order AS sortOrder, created_at AS createdAt FROM series ORDER BY sort_order, created_at, id").all<SeriesRow>();
  return result.results;
}
