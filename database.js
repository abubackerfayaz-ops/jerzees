const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'store.sqlite');
const DATA_DIR = path.join(__dirname, 'data');

let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
  }
  return db;
}

// Convert PostgreSQL SQL to SQLite-compatible SQL
function convertSQL(sql) {
  let s = sql;

  // Replace $N parameter placeholders with ? (PostgreSQL → SQLite)
  s = s.replace(/\$(\d+)\b/g, '?');

  // SERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
  s = s.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');

  // SERIAL (standalone)
  s = s.replace(/\bSERIAL\b/gi, 'INTEGER');

  // ILIKE → LIKE (SQLite LIKE is case-insensitive for ASCII)
  s = s.replace(/\bILIKE\b/gi, 'LIKE');

  // NOW() → datetime('now')
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')");

  // CURRENT_DATE → date('now')
  s = s.replace(/\bCURRENT_DATE\b/gi, "date('now')");

  // CURRENT_TIMESTAMP → datetime('now')
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime('now')");

  // DATE_TRUNC('month', column) → strftime('%Y-%m-01', column)
  s = s.replace(/DATE_TRUNC\s*\(\s*'month'\s*,\s*(\w[\w.]+)\s*\)/gi, "strftime('%Y-%m-01', $1)");

  // Extract and REMOVE RETURNING clause (SQLite doesn't support it)
  const returningMatch = s.match(/\s+RETURNING\s+(.+)$/i);
  let returning = null;
  if (returningMatch) {
    returning = returningMatch[1].trim();
    s = s.replace(/\s+RETURNING\s+.+$/i, '');
  }

  return { sql: s, returning };
}

async function query(sql, params = []) {
  const d = getDb();
  const { sql: convertedSql, returning } = convertSQL(sql);
  const p = params.length ? params : undefined;

  try {
    if (convertedSql.trim().toUpperCase().startsWith('INSERT') && returning) {
      // SQLite doesn't support RETURNING, so do INSERT + SELECT
      const stmt = d.prepare(convertedSql);
      const result = stmt.run(...(p || []));
      const id = Number(result.lastInsertRowid);
      const tableName = extractTableName(convertedSql);
      const returningCols = returning === '*' ? '*' : returning;
      const selectSql = `SELECT ${returningCols} FROM ${tableName} WHERE rowid = ?`;
      const row = d.prepare(selectSql).get(id);
      return { rows: row ? [row] : [], rowCount: 1, lastInsertRowid: id };
    } else {
      const stmt = d.prepare(convertedSql);
      const upper = convertedSql.trim().toUpperCase();
      if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
        const result = stmt.run(...(p || []));
        return { rows: [], rowCount: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      } else {
        const rows = stmt.all(...(p || []));
        return { rows, rowCount: rows.length };
      }
    }
  } catch (err) {
    console.error('SQLite error:', err.message);
    console.error('SQL:', convertedSql);
    console.error('Params:', params);
    throw err;
  }
}

function extractTableName(sql) {
  const match = sql.match(/\bINTO\s+(\w+)/i);
  return match ? match[1] : 'jerseys';
}

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function initialize() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      country TEXT,
      logo_url TEXT,
      description TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS jerseys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      name TEXT NOT NULL,
      season TEXT,
      type TEXT,
      description TEXT,
      featured INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS jersey_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      version TEXT NOT NULL CHECK(version IN ('fan','player','retro')),
      size TEXT NOT NULL CHECK(size IN ('S','M','L','XL','2XL')),
      price REAL NOT NULL DEFAULT 20,
      stock INTEGER NOT NULL DEFAULT 100,
      sku TEXT UNIQUE,
      active INTEGER DEFAULT 1
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      label TEXT DEFAULT 'Home',
      street TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      state TEXT,
      zip TEXT,
      country TEXT DEFAULT 'US',
      is_default INTEGER DEFAULT 0
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      email TEXT NOT NULL,
      phone TEXT,
      shipping_address_id INTEGER REFERENCES addresses(id),
      notes TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      delivery_fee REAL NOT NULL DEFAULT 5,
      name_printing_fee REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid'
        CHECK(payment_status IN ('unpaid','paid','refunded','failed')),
      payment_method TEXT,
      shipping_method TEXT,
      tracking_number TEXT,
      stripe_session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id),
      variant_id INTEGER REFERENCES variants(id),
      size TEXT NOT NULL,
      version TEXT NOT NULL,
      name_text TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      variant_id INTEGER NOT NULL REFERENCES variants(id),
      name_text TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create indexes
  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_team ON jerseys(team_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_featured ON jerseys(featured)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_variants_jersey ON variants(jersey_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_stripe ON orders(stripe_session_id)');

  // Seed admin user
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const existingAdmin = d.prepare('SELECT id FROM customers WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(adminPassword, 10);
    d.prepare('INSERT INTO customers (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)').run('Admin', adminEmail, hash);
    // Admin user created
  }

  // Seed data from JSON if jerseys table is empty
  const count = d.prepare('SELECT COUNT(*) as c FROM jerseys').get();
  if (count.c === 0) {
    await seedFromJson();
  }

  // Database ready
}

async function seedFromJson() {
  const d = getDb();

  let data;
  const yupooPath = path.join(__dirname, 'yupoo_data.json');
  const scrapedPath = path.join(__dirname, 'scraped_yupoo.json');

  if (fs.existsSync(yupooPath)) {
    try {
      const raw = fs.readFileSync(yupooPath, 'utf-8');
      data = JSON.parse(raw);
    } catch (_) {}
  }
  if (!data && fs.existsSync(scrapedPath)) {
    try {
      // scraped_yupoo.json may be UTF-16 encoded
      const raw = fs.readFileSync(scrapedPath);
      const text = raw[0] === 0xFF && raw[1] === 0xFE ? raw.toString('ucs2') : raw.toString('utf-8');
      data = JSON.parse(text);
    } catch (_) {}
  }
  if (!data) {
    return;
  }

  const jerseys = data.jerseys || data;
  if (!Array.isArray(jerseys) || !jerseys.length) {
    return;
  }

  // Map team names from categories in data
  const teamMap = {};
  if (data.categories) {
    for (const cat of data.categories) {
      const name = cat.nameEN || cat.name;
      // Extract team name: remove "Retro" prefix and "系列" suffix
      let teamName = name.replace(/^Retro/i, '').replace(/系列$/i, '').trim();
      // Map common patterns
      if (teamName.includes('Manchester United')) teamName = 'Manchester United';
      else if (teamName.includes('Liverpool')) teamName = 'Liverpool';
      else if (teamName.includes('Arsenal')) teamName = 'Arsenal';
      else if (teamName.includes('Chelsea')) teamName = 'Chelsea';
      else if (teamName.includes('Manchester City')) teamName = 'Manchester City';
      else if (teamName.includes('Tottenham')) teamName = 'Tottenham Hotspur';
      else if (teamName.includes('Real Madrid')) teamName = 'Real Madrid';
      else if (teamName.includes('Barcelona')) teamName = 'Barcelona';
      else if (teamName.includes('AC Milan')) teamName = 'AC Milan';
      else if (teamName.includes('Inter Milan')) teamName = 'Inter Milan';
      else if (teamName.includes('Juventus')) teamName = 'Juventus';
      else if (teamName.includes('Bayern')) teamName = 'Bayern Munich';
      else if (teamName.includes('PSG') || teamName.includes('Paris')) teamName = 'Paris Saint-Germain';
      else if (teamName.includes('Brazil')) teamName = 'Brazil';
      else if (teamName.includes('Argentina')) teamName = 'Argentina';
      else if (teamName.includes('France')) teamName = 'France';
      else if (teamName.includes('Germany')) teamName = 'Germany';
      else if (teamName.includes('Italy')) teamName = 'Italy';
      else if (teamName.includes('Netherlands')) teamName = 'Netherlands';
      else if (teamName.includes('Spain')) teamName = 'Spain';
      else if (teamName.includes('Portugal')) teamName = 'Portugal';
      else if (teamName.includes('England')) teamName = 'England';
      else if (teamName.includes('Ajax')) teamName = 'Ajax';
      else if (teamName.includes('Dortmund')) teamName = 'Borussia Dortmund';
      else if (teamName.includes('Napoli')) teamName = 'Napoli';
      else if (teamName.includes('Roma')) teamName = 'Roma';
      else if (teamName.includes('Atletico') || teamName.includes('Atlético')) teamName = 'Atletico Madrid';
      else if (teamName.includes('Celtic')) teamName = 'Celtic';
      else if (teamName.includes('Rangers')) teamName = 'Rangers';
      else if (teamName.includes('Galatasaray')) teamName = 'Galatasaray';
      else if (teamName.includes('Fenerbahce')) teamName = 'Fenerbahce';
      else if (teamName.includes('Benfica')) teamName = 'Benfica';
      else if (teamName.includes('Porto')) teamName = 'Porto';
      else if (teamName.includes('Sporting')) teamName = 'Sporting CP';
      else if (teamName.includes('Marseille')) teamName = 'Marseille';
      else if (teamName.includes('Lyon')) teamName = 'Lyon';
      else if (teamName.includes('Monaco')) teamName = 'Monaco';
      else if (teamName.includes('Mexico')) teamName = 'Mexico';
      else if (teamName.includes('USA') || teamName.includes('United States')) teamName = 'USA';
      else if (teamName.includes('Japan')) teamName = 'Japan';
      else if (teamName.includes('Korea') || teamName.includes('South Korea')) teamName = 'South Korea';
      else if (teamName.includes('Colombia')) teamName = 'Colombia';
      else if (teamName.includes('Uruguay')) teamName = 'Uruguay';
      else if (teamName.includes('Croatia')) teamName = 'Croatia';
      else if (teamName.includes('Sweden')) teamName = 'Sweden';
      else if (teamName.includes('Denmark')) teamName = 'Denmark';
      else if (teamName.includes('Norway')) teamName = 'Norway';
      else if (teamName.includes('Russia')) teamName = 'Russia';
      else if (teamName.includes('Turkey')) teamName = 'Turkey';
      else if (teamName.includes('Wales')) teamName = 'Wales';
      else if (teamName.includes('Poland')) teamName = 'Poland';
      else if (teamName.includes('Belgium')) teamName = 'Belgium';
      else if (teamName.includes('Costa Rica')) teamName = 'Costa Rica';
      else if (teamName.includes('Nigeria')) teamName = 'Nigeria';
      else if (teamName.includes('Cameroon')) teamName = 'Cameroon';
      else if (teamName.includes('Ivory Coast') || teamName.includes("Côte d'Ivoire")) teamName = 'Ivory Coast';
      else if (teamName.includes('Ghana')) teamName = 'Ghana';
      else if (teamName.includes('Egypt')) teamName = 'Egypt';
      else if (teamName.includes('Algeria')) teamName = 'Algeria';
      else if (teamName.includes('Morocco')) teamName = 'Morocco';
      else if (teamName.includes('Senegal')) teamName = 'Senegal';
      else if (teamName.includes('Tunisia')) teamName = 'Tunisia';

      const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slug) {
        const existing = d.prepare('SELECT id FROM teams WHERE slug = ?').get(slug);
        if (!existing) {
          d.prepare('INSERT INTO teams (name, slug, country) VALUES (?, ?, ?)').run(teamName, slug, '');
        }
      }
    }
  }

  // Also extract team names from jersey entries
  for (const j of jerseys) {
    let teamName = '';
    const name = j.name || j.rawTitle || '';

    if (name.includes('Manchester United') || name.includes('Man United')) teamName = 'Manchester United';
    else if (name.includes('Liverpool')) teamName = 'Liverpool';
    else if (name.includes('Arsenal')) teamName = 'Arsenal';
    else if (name.includes('Chelsea')) teamName = 'Chelsea';
    else if (name.includes('Manchester City') || name.includes('Man City')) teamName = 'Manchester City';
    else if (name.includes('Tottenham')) teamName = 'Tottenham Hotspur';
    else if (name.includes('Real Madrid')) teamName = 'Real Madrid';
    else if (name.includes('Barcelona')) teamName = 'Barcelona';
    else if (name.includes('Milan') || name.includes('AC Milan')) teamName = 'AC Milan';
    else if (name.includes('Inter')) teamName = 'Inter Milan';
    else if (name.includes('Juventus')) teamName = 'Juventus';
    else if (name.includes('Bayern')) teamName = 'Bayern Munich';
    else if (name.includes('PSG') || name.includes('Paris')) teamName = 'Paris Saint-Germain';
    else if (name.includes('Brazil')) teamName = 'Brazil';
    else if (name.includes('Argentina')) teamName = 'Argentina';
    else if (name.includes('France')) teamName = 'France';
    else if (name.includes('Germany')) teamName = 'Germany';
    else if (name.includes('Italy')) teamName = 'Italy';
    else if (name.includes('Netherlands') || name.includes('Holland')) teamName = 'Netherlands';
    else if (name.includes('Spain')) teamName = 'Spain';
    else if (name.includes('Portugal')) teamName = 'Portugal';
    else if (name.includes('England')) teamName = 'England';
    else if (name.includes('Ajax')) teamName = 'Ajax';
    else if (name.includes('Dortmund')) teamName = 'Borussia Dortmund';
    else if (name.includes('Napoli')) teamName = 'Napoli';
    else if (name.includes('Roma')) teamName = 'Roma';
    else if (name.includes('Atletico') || name.includes('Atlético')) teamName = 'Atletico Madrid';
    else if (name.includes('Celtic')) teamName = 'Celtic';
    else if (name.includes('Rangers')) teamName = 'Rangers';
    else if (name.includes('Galatasaray')) teamName = 'Galatasaray';
    else if (name.includes('Fenerbahce')) teamName = 'Fenerbahce';
    else if (name.includes('Benfica')) teamName = 'Benfica';
    else if (name.includes('Porto')) teamName = 'Porto';
    else if (name.includes('Sporting')) teamName = 'Sporting CP';
    else if (name.includes('Marseille')) teamName = 'Marseille';
    else if (name.includes('Lyon')) teamName = 'Lyon';
    else if (name.includes('Monaco')) teamName = 'Monaco';
    else if (name.includes('Mexico')) teamName = 'Mexico';
    else if (name.includes('USA') || name.includes('United States')) teamName = 'USA';
    else if (name.includes('Japan')) teamName = 'Japan';
    else if (name.includes('Korea')) teamName = 'South Korea';
    else if (name.includes('Colombia')) teamName = 'Colombia';
    else if (name.includes('Uruguay')) teamName = 'Uruguay';
    else if (name.includes('Croatia')) teamName = 'Croatia';

    if (teamName) {
      const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const existing = d.prepare('SELECT id FROM teams WHERE slug = ?').get(slug);
      if (!existing) {
        d.prepare('INSERT INTO teams (name, slug, country) VALUES (?, ?, ?)').run(teamName, slug, '');
      }
    }
  }

  // Insert jerseys
  const insertJersey = d.prepare('INSERT INTO jerseys (team_id, name, season, type, description, featured) VALUES (?, ?, ?, ?, ?, 0)');
  const insertImage = d.prepare('INSERT INTO jersey_images (jersey_id, image_url, sort_order) VALUES (?, ?, 0)');
  const insertVariant = d.prepare('INSERT INTO variants (jersey_id, version, size, price, stock, sku) VALUES (?, ?, ?, ?, 100, ?)');

  // Manual transaction (DatabaseSync doesn't have transaction())
  try {
    d.exec('BEGIN');
    let inserted = 0;
    for (const j of jerseys) {
      const name = j.name || j.rawTitle || '';
      let teamName = '';
      if (name.includes('Manchester United') || name.includes('Man United')) teamName = 'Manchester United';
      else if (name.includes('Liverpool')) teamName = 'Liverpool';
      else if (name.includes('Arsenal')) teamName = 'Arsenal';
      else if (name.includes('Chelsea')) teamName = 'Chelsea';
      else if (name.includes('Man City')) teamName = 'Manchester City';
      else if (name.includes('Tottenham')) teamName = 'Tottenham Hotspur';
      else if (name.includes('Real Madrid')) teamName = 'Real Madrid';
      else if (name.includes('Barcelona')) teamName = 'Barcelona';
      else if (name.includes('AC Milan')) teamName = 'AC Milan';
      else if (name.includes('Inter')) teamName = 'Inter Milan';
      else if (name.includes('Juventus')) teamName = 'Juventus';
      else if (name.includes('Bayern')) teamName = 'Bayern Munich';
      else if (name.includes('PSG') || name.includes('Paris')) teamName = 'Paris Saint-Germain';
      else if (name.includes('Brazil')) teamName = 'Brazil';
      else if (name.includes('Argentina')) teamName = 'Argentina';
      else if (name.includes('France')) teamName = 'France';
      else if (name.includes('Germany')) teamName = 'Germany';
      else if (name.includes('Italy')) teamName = 'Italy';
      else if (name.includes('Netherlands') || name.includes('Holland')) teamName = 'Netherlands';
      else if (name.includes('Spain')) teamName = 'Spain';
      else if (name.includes('Portugal')) teamName = 'Portugal';
      else if (name.includes('England')) teamName = 'England';
      else if (name.includes('Ajax')) teamName = 'Ajax';
      else if (name.includes('Dortmund')) teamName = 'Borussia Dortmund';
      else if (name.includes('Napoli')) teamName = 'Napoli';
      else if (name.includes('Roma')) teamName = 'Roma';
      else if (name.includes('Atletico')) teamName = 'Atletico Madrid';
      else if (name.includes('Celtic')) teamName = 'Celtic';
      else if (name.includes('Rangers')) teamName = 'Rangers';
      else if (name.includes('Galatasaray')) teamName = 'Galatasaray';
      else if (name.includes('Fenerbahce')) teamName = 'Fenerbahce';
      else if (name.includes('Benfica')) teamName = 'Benfica';
      else if (name.includes('Porto')) teamName = 'Porto';
      else if (name.includes('Sporting')) teamName = 'Sporting CP';
      else if (name.includes('Marseille')) teamName = 'Marseille';
      else if (name.includes('Lyon')) teamName = 'Lyon';
      else if (name.includes('Monaco')) teamName = 'Monaco';
      else if (name.includes('Mexico')) teamName = 'Mexico';
      else if (name.includes('USA')) teamName = 'USA';
      else if (name.includes('Japan')) teamName = 'Japan';
      else if (name.includes('Korea')) teamName = 'South Korea';
      else if (name.includes('Colombia')) teamName = 'Colombia';
      else if (name.includes('Uruguay')) teamName = 'Uruguay';
      else if (name.includes('Croatia')) teamName = 'Croatia';

      const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const team = d.prepare('SELECT id FROM teams WHERE slug = ?').get(slug);
      if (!team) continue;

      const season = j.season || '';
      const type = (j.type || '').toLowerCase();
      const img = j.image || '';

      const result = insertJersey.run(team.id, name, season, type || null, null);
      const jerseyId = Number(result.lastInsertRowid);

      if (img) insertImage.run(jerseyId, img);

      // Create default variants
      const versions = ['fan', 'player', 'retro'];
      const sizes = ['S', 'M', 'L', 'XL', '2XL'];
      const prices = { fan: 20, player: 23, retro: 25 };
      for (const ver of versions) {
        for (const sz of sizes) {
          const sku = `${jerseyId}-${ver}-${sz}`;
          insertVariant.run(jerseyId, ver, sz, prices[ver], sku);
        }
      }
      inserted++;
    }
    d.exec('COMMIT');
  } catch (txErr) {
    d.exec('ROLLBACK');
    console.error('Data seeding failed:', txErr.message);
  }
}

// Keep the same interface for backward compatibility
async function getClient() {
  return getDb();
}

function savepoint(client, name) {}

function rollbackToSavepoint(client, name) {}

function releaseSavepoint(client, name) {}

module.exports = { getDb, query, initialize, all, get, getClient, savepoint, rollbackToReleaseSavepoint: releaseSavepoint, savepoint, rollbackToSavepoint, releaseSavepoint };
