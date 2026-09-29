# RAKTASETU — Backend Prototype

A working backend for the RAKTASETU blood-donation platform: donor/organization/admin
accounts, blood camps, donor admission, live inventory, AI-style donor matching,
emergency alerts, and a leaderboard.

## Why plain Node instead of Express + Postgres

This was built and tested inside a sandbox with **no internet access**, so `npm install`
couldn't reach the npm registry for `express`, `pg`, `bcrypt`, or `jsonwebtoken`. Instead:

| Instead of... | This uses... |
|---|---|
| Express | Node's built-in `http` module with a small custom router |
| PostgreSQL + `pg` | Node's built-in `node:sqlite` (experimental, ships with Node 22+) |
| `bcrypt` | `crypto.scrypt` (built-in) |
| `jsonwebtoken` | A small HMAC-SHA256 signed token, same shape as a JWT (built-in `crypto`) |

**Result: it runs with zero `npm install` steps** — just `node server.js`, on any
machine with Node 22+. The route/response shapes were written Express-style on purpose,
so moving to real Express + Postgres later is mechanical, not a rewrite:
- Replace `db.js` with a `pg.Pool` and swap the `.prepare(sql).run/get/all()` calls for
  `pool.query(sql, args)` — the SQL itself is standard and mostly portable as-is.
- Replace the router in `server.js` with `app.get/post/patch(...)` — the handler bodies
  can move over almost unchanged.
- Swap `auth.js` for `bcrypt` + `jsonwebtoken` — same function signatures.

## Running it

```bash
cd raktasetu-backend
node server.js
# -> RAKTASETU backend prototype listening on http://localhost:3001
```

No `npm install` needed. A SQLite file (`raktasetu.db`) is created automatically on
first run, and a default admin account is seeded:

- **Admin login:** mobile `9999999999`, password `admin123`

The existing marketing page is served at `GET /` from `public/index.html` (this is
still a static page — its buttons aren't wired to these APIs yet; that's a frontend
task, described below).

## API overview

All bodies are JSON. Authenticated routes expect `Authorization: Bearer <token>`.

### Auth
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/otp/request` | anyone | `{mobile}` → returns OTP directly (no SMS gateway wired up — dev mode) |
| POST | `/api/auth/donor/register` | anyone | `{mobile, otp, password, name, bloodGroup, city, radiusKm?, anonymous?}` |
| POST | `/api/auth/donor/login` | anyone | `{mobile, password}` |
| POST | `/api/auth/org/register` | anyone | `{mobile, password, orgName, certificateInfo?}` → PENDING until admin approves |
| POST | `/api/auth/org/login` | anyone | Fails until an admin approves the org |
| POST | `/api/auth/admin/login` | anyone | Use the seeded admin above |

### Donor
| Method | Path | Who |
|---|---|---|
| GET | `/api/donor/me` | donor | Profile + live eligibility status |
| PATCH | `/api/donor/preferences` | donor | `{radiusKm?, anonymous?, emergencyAlerts?}` |
| GET | `/api/leaderboard?city=` | public | Top donors by points |

### Camps & donations
| Method | Path | Who |
|---|---|---|
| POST | `/api/camps` | organization | `{location, city, date, time?, gifts?}` |
| GET | `/api/camps?city=` | public | List camps |
| POST | `/api/camps/:id/admit` | organization | `{donorId, mlCollected}` — checks 90-day eligibility, awards points, updates inventory |

### Inventory & matching
| Method | Path | Who |
|---|---|---|
| GET | `/api/inventory?city=&bloodGroup=` | public | Unit counts |
| GET | `/api/match?bloodGroup=&city=&limit=` | org/admin | Ranked, blood-compatible, eligible donors |
| POST | `/api/emergency` | org/admin | `{bloodGroup, city}` — mock alert dispatch to matched donors |

### Admin
| Method | Path | Who |
|---|---|---|
| GET | `/api/admin/organizations?status=` | admin | List orgs (PENDING/APPROVED/REJECTED) |
| PATCH | `/api/admin/organizations/:id` | admin | `{status: "APPROVED"\|"REJECTED"}` |
| GET | `/api/admin/fraud-watch` | admin | Donors with repeat donations under 60 days apart |

## What's simplified vs. the site's marketing copy

- **OTP is returned in the API response**, not sent by SMS — there's no SMS provider
  wired up. Swap in Twilio/MSG91 etc. before going live.
- **Aadhaar / government-certificate verification** is stored as a plain text field
  (`certificateInfo`), not verified against any registry.
- **Distance-based radius matching** is not geographic yet — matching currently scores
  by same-city + blood-group compatibility + eligibility, not real lat/long distance.
  Add donor coordinates and a haversine calculation to make this exact.
- **Fraud detection** is a simple time-window rule, not a trained model.
- **Device-lock / session termination** and **refresh-token rotation** aren't
  implemented — tokens are stateless with a 12-hour expiry.

These are reasonable next slices once the core flow above is confirmed to be what
you want — happy to build any of them out further.
