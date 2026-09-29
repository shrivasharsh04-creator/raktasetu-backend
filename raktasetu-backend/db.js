// db.js — storage layer.
// Uses Node's built-in `node:sqlite` module so the prototype runs with ZERO
// npm installs (this sandbox has no network access to the npm registry).
// The query shapes below map 1:1 onto standard SQL, so swapping this file
// for a `pg` (PostgreSQL) client later is a small, mechanical change —
// none of the route/controller code above it needs to change.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'raktasetu.db'));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('DONOR','ORGANIZATION','ADMIN')),
    mobile TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS donor_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    donor_id TEXT UNIQUE NOT NULL,
    blood_group TEXT NOT NULL,
    city TEXT NOT NULL,
    radius_km INTEGER DEFAULT 15,
    anonymous INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    last_donation_date TEXT,
    emergency_alerts INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS organizations (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    org_name TEXT NOT NULL,
    certificate_info TEXT,
    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED'))
  );

  CREATE TABLE IF NOT EXISTS camps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_user_id INTEGER NOT NULL REFERENCES users(id),
    location TEXT NOT NULL,
    city TEXT NOT NULL,
    camp_date TEXT NOT NULL,
    camp_time TEXT,
    gifts TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_user_id INTEGER NOT NULL REFERENCES users(id),
    camp_id INTEGER REFERENCES camps(id),
    blood_group TEXT NOT NULL,
    ml_collected INTEGER NOT NULL,
    city TEXT NOT NULL,
    donated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory (
    city TEXT NOT NULL,
    blood_group TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (city, blood_group)
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    mobile TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

module.exports = db;
