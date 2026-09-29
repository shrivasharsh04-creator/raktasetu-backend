const crypto = require('crypto');

function cityCode(city) {
  return city.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
}

function generateDonorId(city) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 5);
  return `${cityCode(city)}-${rand}`;
}

function daysBetween(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr).getTime();
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

const ELIGIBILITY_DAYS = 90;

function isEligible(lastDonationDate) {
  return daysBetween(lastDonationDate) >= ELIGIBILITY_DAYS;
}

// Simple compatibility map: which donor groups can give to a requested group.
// (O- is the universal donor; AB+ is the universal recipient.)
const COMPATIBLE_DONORS = {
  'O-': ['O-'],
  'O+': ['O-', 'O+'],
  'A-': ['O-', 'A-'],
  'A+': ['O-', 'O+', 'A-', 'A+'],
  'B-': ['O-', 'B-'],
  'B+': ['O-', 'O+', 'B-', 'B+'],
  'AB-': ['O-', 'A-', 'B-', 'AB-'],
  'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

module.exports = {
  generateDonorId,
  cityCode,
  daysBetween,
  isEligible,
  ELIGIBILITY_DAYS,
  COMPATIBLE_DONORS,
  sendJson,
};
