const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const usePg = Boolean(process.env.DATABASE_URL);

let pgPool = null;
let sqliteDb = null;

if (usePg) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
}

function getDb() {
  if (usePg) return pgPool;
  if (!sqliteDb) {
    const DATA_DIR = path.join(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    sqliteDb = new DatabaseSync(path.join(DATA_DIR, 'store.sqlite'));
    sqliteDb.exec('PRAGMA journal_mode=WAL');
    sqliteDb.exec('PRAGMA foreign_keys=ON');
  }
  return sqliteDb;
}

// Convert PostgreSQL SQL to SQLite-compatible SQL (for local SQLite mode)
function convertSQL(sql) {
  let s = sql;
  s = s.replace(/\$(\d+)\b/g, '?');
  s = s.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  s = s.replace(/\bSERIAL\b/gi, 'INTEGER');
  s = s.replace(/\bILIKE\b/gi, 'LIKE');
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')");
  s = s.replace(/\bCURRENT_DATE\b/gi, "date('now')");
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime('now')");
  s = s.replace(/DATE_TRUNC\s*\(\s*'month'\s*,\s*(\w[\w.]+)\s*\)/gi, "strftime('%Y-%m-01', $1)");

  const returningMatch = s.match(/\s+RETURNING\s+(.+)$/i);
  let returning = null;
  if (returningMatch) {
    returning = returningMatch[1].trim();
    s = s.replace(/\s+RETURNING\s+.+$/i, '');
  }

  return { sql: s, returning };
}

function extractTableName(sql) {
  const match = sql.match(/\bINTO\s+(\w+)/i);
  return match ? match[1] : 'jerseys';
}

async function query(sql, params = []) {
  if (usePg) {
    try {
      const res = await pgPool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (err) {
      console.error('PostgreSQL error:', err.message);
      console.error('SQL:', sql);
      console.error('Params:', params);
      throw err;
    }
  }

  const d = getDb();
  const { sql: convertedSql, returning } = convertSQL(sql);
  const p = params.length ? params : undefined;

  try {
    if (convertedSql.trim().toUpperCase().startsWith('INSERT') && returning) {
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

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function initialize() {
  if (usePg) {
    console.log('Connected to PostgreSQL database (Supabase)');
    // Ensure tables exist in PostgreSQL
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        country TEXT,
        logo_url TEXT,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS jerseys (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        season TEXT,
        type TEXT,
        description TEXT,
        featured INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS jersey_images (
        id SERIAL PRIMARY KEY,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS variants (
        id SERIAL PRIMARY KEY,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
        version TEXT NOT NULL CHECK(version IN ('fan','player','retro')),
        size TEXT NOT NULL CHECK(size IN ('S','M','L','XL','2XL')),
        price NUMERIC NOT NULL DEFAULT 20,
        stock INTEGER NOT NULL DEFAULT 100,
        sku TEXT UNIQUE,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS addresses (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        label TEXT DEFAULT 'Home',
        street TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        state TEXT,
        zip TEXT,
        country TEXT DEFAULT 'US',
        is_default INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        email TEXT NOT NULL,
        phone TEXT,
        shipping_address_id INTEGER REFERENCES addresses(id),
        notes TEXT,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        delivery_fee NUMERIC NOT NULL DEFAULT 5,
        name_printing_fee NUMERIC NOT NULL DEFAULT 0,
        total NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
        payment_status TEXT NOT NULL DEFAULT 'unpaid'
          CHECK(payment_status IN ('unpaid','paid','refunded','failed')),
        payment_method TEXT,
        shipping_method TEXT,
        tracking_number TEXT,
        stripe_session_id TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id),
        variant_id INTEGER REFERENCES variants(id),
        size TEXT NOT NULL,
        version TEXT NOT NULL,
        name_text TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price NUMERIC NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        variant_id INTEGER NOT NULL REFERENCES variants(id),
        name_text TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure admin exists in PG
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const existingAdmin = (await pgPool.query('SELECT id FROM customers WHERE email = $1', [adminEmail])).rows[0];
    if (!existingAdmin) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(adminPassword, 10);
      await pgPool.query('INSERT INTO customers (name, email, password_hash, is_admin) VALUES ($1, $2, $3, 1)', ['Admin', adminEmail, hash]);
    }
    // Normalize variant pricing rules: Fan = €20, Player = €25, Retro = €25
    await pgPool.query("UPDATE variants SET price = 20 WHERE version = 'fan'");
    await pgPool.query("UPDATE variants SET price = 25 WHERE version = 'player'");
    await pgPool.query("UPDATE variants SET price = 25 WHERE version = 'retro'");
    return;
  }

  const d = getDb();
  console.log('Connected to SQLite database');

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

  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_team ON jerseys(team_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_featured ON jerseys(featured)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_variants_jersey ON variants(jersey_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_stripe ON orders(stripe_session_id)');

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const existingAdmin = d.prepare('SELECT id FROM customers WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(adminPassword, 10);
    d.prepare('INSERT INTO customers (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)').run('Admin', adminEmail, hash);
  }

  // Normalize variant pricing rules: Fan = €20, Player = €25, Retro = €25
  d.exec("UPDATE variants SET price = 20 WHERE version = 'fan'");
  d.exec("UPDATE variants SET price = 25 WHERE version = 'player'");
  d.exec("UPDATE variants SET price = 25 WHERE version = 'retro'");
}

async function getClient() {
  return getDb();
}

function savepoint(client, name) {}
function rollbackToSavepoint(client, name) {}
function releaseSavepoint(client, name) {}

module.exports = {
  getDb,
  query,
  initialize,
  all,
  get,
  getClient,
  savepoint,
  rollbackToReleaseSavepoint: releaseSavepoint,
  rollbackToSavepoint,
  releaseSavepoint
};
