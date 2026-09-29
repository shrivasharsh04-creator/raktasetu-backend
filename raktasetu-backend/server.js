// server.js — RAKTASETU prototype backend.
//
// Zero external dependencies: uses Node's built-in `http` module as a
// stand-in for Express, and `node:sqlite` as a stand-in for Postgres.
// This sandbox has no network access to install npm packages, so this
// version runs with nothing but `node server.js`. The route shapes and
// response bodies below are written so a real Express + `pg` app can be
// dropped in later without changing the API contract — see README.md.

const http = require('http');
const { URL } = require('url');
const db = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const {
  generateDonorId,
  isEligible,
  daysBetween,
  ELIGIBILITY_DAYS,
  COMPATIBLE_DONORS,
  sendJson,
} = require('./utils');

const PORT = process.env.PORT || 3001;

// ---------- tiny router ----------
const routes = []; // { method, pattern: RegExp, keys: string[], handler }

function route(method, path, handler) {
  const keys = [];
  const pattern = new RegExp(
    '^' +
      path
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg;
        })
        .join('/') +
      '/?$'
  );
  routes.push({ method, pattern, keys, handler });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifyToken(token);
}

function requireAuth(req, res, ...allowedRoles) {
  const payload = getAuth(req);
  if (!payload) {
    sendJson(res, 401, { error: 'Missing or invalid token' });
    return null;
  }
  if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
    sendJson(res, 403, { error: 'Not authorized for this action' });
    return null;
  }
  return payload;
}

// ---------- seed a default admin account ----------
(function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('ADMIN');
  if (existing) return;
  const { hash, salt } = hashPassword('admin123');
  db.prepare(
    'INSERT INTO users (role, mobile, password_hash, password_salt, name) VALUES (?, ?, ?, ?, ?)'
  ).run('ADMIN', '9999999999', hash, salt, 'Platform Admin');
  console.log('Seeded default admin -> mobile: 9999999999 / password: admin123');
})();

// =====================================================================
// AUTH — OTP, donor/org/admin register & login
// =====================================================================

route('POST', '/api/auth/otp/request', async (req, res) => {
  const { mobile } = await readBody(req);
  if (!mobile) return sendJson(res, 400, { error: 'mobile is required' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 5 * 60 * 1000;
  db.prepare('INSERT OR REPLACE INTO otp_codes (mobile, code, expires_at) VALUES (?, ?, ?)').run(
    mobile,
    code,
    expiresAt
  );
  // DEV MODE: no SMS gateway is wired up, so the OTP is returned directly.
  // In production this would be sent via an SMS provider and never returned.
  sendJson(res, 200, { message: 'OTP generated (dev mode — no SMS gateway configured)', otp: code });
});

function checkOtp(mobile, otp) {
  const row = db.prepare('SELECT * FROM otp_codes WHERE mobile = ?').get(mobile);
  if (!row) return false;
  if (row.code !== otp) return false;
  if (Date.now() > row.expires_at) return false;
  db.prepare('DELETE FROM otp_codes WHERE mobile = ?').run(mobile);
  return true;
}

route('POST', '/api/auth/donor/register', async (req, res) => {
  const { mobile, otp, password, name, bloodGroup, city, radiusKm, anonymous } = await readBody(req);
  if (!mobile || !otp || !password || !name || !bloodGroup || !city) {
    return sendJson(res, 400, { error: 'mobile, otp, password, name, bloodGroup, city are required' });
  }
  if (!checkOtp(mobile, otp)) return sendJson(res, 400, { error: 'Invalid or expired OTP' });
  const existing = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobile);
  if (existing) return sendJson(res, 409, { error: 'Mobile number already registered' });

  const { hash, salt } = hashPassword(password);
  const insertUser = db
    .prepare('INSERT INTO users (role, mobile, password_hash, password_salt, name) VALUES (?, ?, ?, ?, ?)')
    .run('DONOR', mobile, hash, salt, name);
  const userId = Number(insertUser.lastInsertRowid);
  const donorId = generateDonorId(city);
  db.prepare(
    `INSERT INTO donor_profiles (user_id, donor_id, blood_group, city, radius_km, anonymous)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, donorId, bloodGroup, city, radiusKm || 15, anonymous ? 1 : 0);

  const token = signToken({ userId, role: 'DONOR', donorId });
  sendJson(res, 201, { token, donorId, message: 'Donor registered successfully' });
});

route('POST', '/api/auth/donor/login', async (req, res) => {
  const { mobile, password } = await readBody(req);
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND role = ?').get(mobile, 'DONOR');
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Invalid mobile number or password' });
  }
  const profile = db.prepare('SELECT * FROM donor_profiles WHERE user_id = ?').get(user.id);
  const token = signToken({ userId: user.id, role: 'DONOR', donorId: profile.donor_id });
  sendJson(res, 200, { token, donorId: profile.donor_id });
});

route('POST', '/api/auth/org/register', async (req, res) => {
  const { mobile, password, orgName, certificateInfo } = await readBody(req);
  if (!mobile || !password || !orgName) {
    return sendJson(res, 400, { error: 'mobile, password, orgName are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobile);
  if (existing) return sendJson(res, 409, { error: 'Mobile number already registered' });

  const { hash, salt } = hashPassword(password);
  const insertUser = db
    .prepare('INSERT INTO users (role, mobile, password_hash, password_salt, name) VALUES (?, ?, ?, ?, ?)')
    .run('ORGANIZATION', mobile, hash, salt, orgName);
  const userId = Number(insertUser.lastInsertRowid);
  db.prepare('INSERT INTO organizations (user_id, org_name, certificate_info) VALUES (?, ?, ?)').run(
    userId,
    orgName,
    certificateInfo || null
  );
  sendJson(res, 201, { message: 'Organization submitted — pending admin approval' });
});

route('POST', '/api/auth/org/login', async (req, res) => {
  const { mobile, password } = await readBody(req);
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND role = ?').get(mobile, 'ORGANIZATION');
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Invalid mobile number or password' });
  }
  const org = db.prepare('SELECT * FROM organizations WHERE user_id = ?').get(user.id);
  if (org.status !== 'APPROVED') {
    return sendJson(res, 403, { error: `Organization is ${org.status.toLowerCase()} — cannot log in yet` });
  }
  const token = signToken({ userId: user.id, role: 'ORGANIZATION', orgName: org.org_name });
  sendJson(res, 200, { token, orgName: org.org_name });
});

route('POST', '/api/auth/admin/login', async (req, res) => {
  const { mobile, password } = await readBody(req);
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND role = ?').get(mobile, 'ADMIN');
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Invalid mobile number or password' });
  }
  const token = signToken({ userId: user.id, role: 'ADMIN' });
  sendJson(res, 200, { token });
});

// =====================================================================
// DONOR
// =====================================================================

route('GET', '/api/donor/me', async (req, res) => {
  const auth = requireAuth(req, res, 'DONOR');
  if (!auth) return;
  const profile = db
    .prepare(
      `SELECT u.name, u.mobile, p.* FROM users u
       JOIN donor_profiles p ON p.user_id = u.id WHERE u.id = ?`
    )
    .get(auth.userId);
  sendJson(res, 200, {
    ...profile,
    eligible: isEligible(profile.last_donation_date),
    daysSinceLastDonation: daysBetween(profile.last_donation_date),
  });
});

route('PATCH', '/api/donor/preferences', async (req, res) => {
  const auth = requireAuth(req, res, 'DONOR');
  if (!auth) return;
  const { radiusKm, anonymous, emergencyAlerts } = await readBody(req);
  db.prepare(
    `UPDATE donor_profiles SET
       radius_km = COALESCE(?, radius_km),
       anonymous = COALESCE(?, anonymous),
       emergency_alerts = COALESCE(?, emergency_alerts)
     WHERE user_id = ?`
  ).run(
    radiusKm ?? null,
    anonymous === undefined ? null : anonymous ? 1 : 0,
    emergencyAlerts === undefined ? null : emergencyAlerts ? 1 : 0,
    auth.userId
  );
  sendJson(res, 200, { message: 'Preferences updated' });
});

route('GET', '/api/leaderboard', async (req, res, query) => {
  const city = query.get('city');
  const rows = city
    ? db
        .prepare(
          `SELECT donor_id, points, city FROM donor_profiles WHERE city = ? ORDER BY points DESC LIMIT 20`
        )
        .all(city)
    : db.prepare(`SELECT donor_id, points, city FROM donor_profiles ORDER BY points DESC LIMIT 20`).all();
  sendJson(res, 200, { leaderboard: rows });
});

// =====================================================================
// BLOOD CAMPS & ADMISSIONS (Organization)
// =====================================================================

route('POST', '/api/camps', async (req, res) => {
  const auth = requireAuth(req, res, 'ORGANIZATION');
  if (!auth) return;
  const { location, city, date, time, gifts } = await readBody(req);
  if (!location || !city || !date) {
    return sendJson(res, 400, { error: 'location, city, date are required' });
  }
  const result = db
    .prepare(
      `INSERT INTO camps (org_user_id, location, city, camp_date, camp_time, gifts)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(auth.userId, location, city, date, time || null, gifts || null);
  sendJson(res, 201, { campId: Number(result.lastInsertRowid), message: 'Camp created' });
});

route('GET', '/api/camps', async (req, res, query) => {
  const city = query.get('city');
  const rows = city
    ? db.prepare('SELECT * FROM camps WHERE city = ? ORDER BY camp_date').all(city)
    : db.prepare('SELECT * FROM camps ORDER BY camp_date').all();
  sendJson(res, 200, { camps: rows });
});

route('POST', '/api/camps/:id/admit', async (req, res, query, params) => {
  const auth = requireAuth(req, res, 'ORGANIZATION');
  if (!auth) return;
  const { donorId, mlCollected } = await readBody(req);
  if (!donorId || !mlCollected) return sendJson(res, 400, { error: 'donorId and mlCollected are required' });

  const camp = db.prepare('SELECT * FROM camps WHERE id = ?').get(params.id);
  if (!camp) return sendJson(res, 404, { error: 'Camp not found' });

  const profile = db.prepare('SELECT * FROM donor_profiles WHERE donor_id = ?').get(donorId);
  if (!profile) return sendJson(res, 404, { error: 'Donor ID not found' });
  if (!isEligible(profile.last_donation_date)) {
    return sendJson(res, 409, {
      error: `Donor not yet eligible — ${ELIGIBILITY_DAYS - daysBetween(profile.last_donation_date)} day(s) remaining`,
    });
  }

  db.prepare(
    `INSERT INTO donations (donor_user_id, camp_id, blood_group, ml_collected, city)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profile.user_id, camp.id, profile.blood_group, mlCollected, camp.city);

  const pointsEarned = Math.floor(mlCollected / 100);
  db.prepare(
    `UPDATE donor_profiles SET points = points + ?, last_donation_date = CURRENT_TIMESTAMP WHERE user_id = ?`
  ).run(pointsEarned, profile.user_id);

  const existingInv = db
    .prepare('SELECT * FROM inventory WHERE city = ? AND blood_group = ?')
    .get(camp.city, profile.blood_group);
  if (existingInv) {
    db.prepare('UPDATE inventory SET units = units + 1 WHERE city = ? AND blood_group = ?').run(
      camp.city,
      profile.blood_group
    );
  } else {
    db.prepare('INSERT INTO inventory (city, blood_group, units) VALUES (?, ?, 1)').run(
      camp.city,
      profile.blood_group
    );
  }

  sendJson(res, 200, { message: 'Donation recorded', pointsEarned });
});

// =====================================================================
// INVENTORY (public)
// =====================================================================

route('GET', '/api/inventory', async (req, res, query) => {
  const city = query.get('city');
  const bloodGroup = query.get('bloodGroup');
  let sql = 'SELECT * FROM inventory WHERE 1=1';
  const args = [];
  if (city) {
    sql += ' AND city = ?';
    args.push(city);
  }
  if (bloodGroup) {
    sql += ' AND blood_group = ?';
    args.push(bloodGroup);
  }
  const rows = db.prepare(sql).all(...args);
  sendJson(res, 200, { inventory: rows });
});

// =====================================================================
// AI SMART MATCHING + EMERGENCY MODE
// =====================================================================

function rankDonors(bloodGroup, city) {
  const compatibleGroups = COMPATIBLE_DONORS[bloodGroup] || [bloodGroup];
  const placeholders = compatibleGroups.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT u.id as user_id, u.name, p.donor_id, p.blood_group, p.city, p.points,
              p.last_donation_date, p.anonymous, p.emergency_alerts
       FROM donor_profiles p JOIN users u ON u.id = p.user_id
       WHERE p.blood_group IN (${placeholders})`
    )
    .all(...compatibleGroups);

  return rows
    .map((d) => {
      const eligible = isEligible(d.last_donation_date);
      const sameCity = d.city === city;
      const exactGroup = d.blood_group === bloodGroup;
      // Simple weighted score: eligibility gates it; same-city and exact
      // blood-group match are the strongest signals, points break ties.
      let score = 0;
      if (eligible) score += 50;
      if (sameCity) score += 30;
      if (exactGroup) score += 15;
      score += Math.min(d.points, 5);
      return {
        donorId: d.donor_id,
        displayName: d.anonymous ? null : d.name,
        bloodGroup: d.blood_group,
        city: d.city,
        eligible,
        score,
      };
    })
    .filter((d) => d.eligible)
    .sort((a, b) => b.score - a.score);
}

route('GET', '/api/match', async (req, res, query) => {
  const auth = requireAuth(req, res, 'ORGANIZATION', 'ADMIN');
  if (!auth) return;
  const bloodGroup = query.get('bloodGroup');
  const city = query.get('city');
  const limit = Number(query.get('limit')) || 10;
  if (!bloodGroup || !city) return sendJson(res, 400, { error: 'bloodGroup and city query params required' });
  sendJson(res, 200, { matches: rankDonors(bloodGroup, city).slice(0, limit) });
});

route('POST', '/api/emergency', async (req, res) => {
  const auth = requireAuth(req, res, 'ORGANIZATION', 'ADMIN');
  if (!auth) return;
  const { bloodGroup, city } = await readBody(req);
  if (!bloodGroup || !city) return sendJson(res, 400, { error: 'bloodGroup and city are required' });
  const matches = rankDonors(bloodGroup, city).filter((_, i, arr) => arr[i]); // eligible only, already sorted
  // Mock alert dispatch — a real system would push notifications/SMS here.
  sendJson(res, 200, {
    message: `Emergency alert dispatched to ${matches.length} eligible donor(s)`,
    alerted: matches.slice(0, 50),
  });
});

// =====================================================================
// ADMIN
// =====================================================================

route('GET', '/api/admin/organizations', async (req, res, query) => {
  const auth = requireAuth(req, res, 'ADMIN');
  if (!auth) return;
  const status = query.get('status');
  const rows = status
    ? db
        .prepare(
          `SELECT o.*, u.mobile, u.name FROM organizations o JOIN users u ON u.id = o.user_id WHERE o.status = ?`
        )
        .all(status)
    : db.prepare(`SELECT o.*, u.mobile, u.name FROM organizations o JOIN users u ON u.id = o.user_id`).all();
  sendJson(res, 200, { organizations: rows });
});

route('PATCH', '/api/admin/organizations/:id', async (req, res, query, params) => {
  const auth = requireAuth(req, res, 'ADMIN');
  if (!auth) return;
  const { status } = await readBody(req);
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return sendJson(res, 400, { error: 'status must be APPROVED or REJECTED' });
  }
  db.prepare('UPDATE organizations SET status = ? WHERE user_id = ?').run(status, params.id);
  sendJson(res, 200, { message: `Organization ${status.toLowerCase()}` });
});

route('GET', '/api/admin/fraud-watch', async (req, res) => {
  const auth = requireAuth(req, res, 'ADMIN');
  if (!auth) return;
  // Flags donors who have donated more than once in under 60 days —
  // below the safe 90-day window — as a simple fraud/error signal.
  const rows = db
    .prepare(
      `SELECT donor_user_id, COUNT(*) as donation_count,
              MIN(donated_at) as first_donation, MAX(donated_at) as last_donation
       FROM donations
       GROUP BY donor_user_id
       HAVING donation_count > 1`
    )
    .all();
  const flagged = rows.filter((r) => {
    const days = (new Date(r.last_donation).getTime() - new Date(r.first_donation).getTime()) / 86400000;
    return r.donation_count > 1 && days < 60;
  });
  sendJson(res, 200, { flagged });
});

// =====================================================================
// Static: serve the existing marketing page at "/"
// =====================================================================

route('GET', '/', async (req, res) => {
  const fs = require('fs');
  const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

// ---------- dispatch ----------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.pattern);
    if (!match) continue;
    const params = {};
    r.keys.forEach((key, i) => (params[key] = match[i + 1]));
    try {
      await r.handler(req, res, parsedUrl.searchParams, params);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error', detail: err.message });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`RAKTASETU backend prototype listening on http://localhost:${PORT}`);
});
