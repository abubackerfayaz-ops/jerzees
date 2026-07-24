/**
 * Migrate data from Supabase PostgreSQL to local SQLite
 * Run: node migrate_to_sqlite.js
 */
require('dotenv').config({ path: __dirname + '/.env' });

const { Client } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'store.sqlite');
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Initialise SQLite ────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA foreign_keys=OFF');  // Off during migration

console.log('Connected to SQLite:', DB_PATH);

// ─── Connect to PostgreSQL ────────────────────────────────────────────────────
const pg = new Client({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pg.connect();
  console.log('Connected to PostgreSQL (Supabase)');

  // ── Teams ─────────────────────────────────────────────────────────────────
  console.log('\n→ Migrating teams...');
  const teams = (await pg.query('SELECT * FROM teams ORDER BY id')).rows;
  db.exec("DELETE FROM teams");
  db.exec("DELETE FROM sqlite_sequence WHERE name='teams'");
  const insTeam = db.prepare('INSERT INTO teams (id, name, slug, country, logo_url, description) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const t of teams) {
    insTeam.run(t.id, t.name, t.slug, t.country || '', t.logo_url || null, t.description || null);
  }
  db.exec('COMMIT');
  console.log(`  ✓ ${teams.length} teams`);

  // ── Jerseys ───────────────────────────────────────────────────────────────
  console.log('→ Migrating jerseys...');
  const jerseys = (await pg.query('SELECT * FROM jerseys ORDER BY id')).rows;
  db.exec("DELETE FROM jerseys");
  db.exec("DELETE FROM sqlite_sequence WHERE name='jerseys'");
  const insJersey = db.prepare('INSERT INTO jerseys (id, team_id, name, season, type, description, featured, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const j of jerseys) {
    insJersey.run(
      j.id, j.team_id, j.name,
      j.season || null, j.type || null, j.description || null,
      j.featured ? 1 : 0,
      j.created_at ? String(j.created_at) : null
    );
  }
  db.exec('COMMIT');
  console.log(`  ✓ ${jerseys.length} jerseys`);

  // ── Jersey Images ─────────────────────────────────────────────────────────
  console.log('→ Migrating jersey images...');
  const images = (await pg.query('SELECT * FROM jersey_images ORDER BY id')).rows;
  db.exec("DELETE FROM jersey_images");
  db.exec("DELETE FROM sqlite_sequence WHERE name='jersey_images'");
  const insImg = db.prepare('INSERT INTO jersey_images (id, jersey_id, image_url, sort_order) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const img of images) {
    insImg.run(img.id, img.jersey_id, img.image_url, img.sort_order || 0);
  }
  db.exec('COMMIT');
  console.log(`  ✓ ${images.length} images`);

  // ── Variants ──────────────────────────────────────────────────────────────
  console.log('→ Migrating variants...');
  const variants = (await pg.query('SELECT * FROM variants ORDER BY id')).rows;
  db.exec("DELETE FROM variants");
  db.exec("DELETE FROM sqlite_sequence WHERE name='variants'");
  const insVar = db.prepare('INSERT INTO variants (id, jersey_id, version, size, price, stock, sku, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const v of variants) {
    insVar.run(v.id, v.jersey_id, v.version, v.size, v.price, v.stock, v.sku || null, v.active ? 1 : 0);
  }
  db.exec('COMMIT');
  console.log(`  ✓ ${variants.length} variants`);

  // ── Customers ─────────────────────────────────────────────────────────────
  console.log('→ Migrating customers...');
  const customers = (await pg.query('SELECT * FROM customers ORDER BY id')).rows;
  db.exec("DELETE FROM customers");
  db.exec("DELETE FROM sqlite_sequence WHERE name='customers'");
  const insCust = db.prepare('INSERT INTO customers (id, name, email, phone, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const c of customers) {
    insCust.run(c.id, c.name, c.email, c.phone || null, c.password_hash || null, c.is_admin ? 1 : 0, c.created_at ? String(c.created_at) : null);
  }
  db.exec('COMMIT');
  console.log(`  ✓ ${customers.length} customers`);

  // If no admin user exists, create one
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
  const adminExists = db.prepare('SELECT id FROM customers WHERE email = ?').get(adminEmail);
  if (!adminExists) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO customers (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)').run('Admin', adminEmail, hash);
    console.log(`  ✓ Created admin user: ${adminEmail}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  db.exec('PRAGMA foreign_keys=ON');
  console.log('\n✅ Migration complete!');
  console.log(`   Teams:   ${teams.length}`);
  console.log(`   Jerseys: ${jerseys.length}`);
  console.log(`   Images:  ${images.length}`);
  console.log(`   Variants: ${variants.length}`);

  await pg.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  pg.end().catch(() => {});
  process.exit(1);
});
