const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   FLAT-FILE "DB"
   ============================================================ */
const FACILITIES = [
  { id:'vincom',  name:'Vincom Center Bà Triệu', addr:'191 Bà Triệu, Hai Bà Trưng, Hà Nội',
    lat:21.0116, lng:105.8497, total:120, avail:45, type:'basement', ev:true,
    hours:'06:00–23:00', rate:20000, cap:120000 },
  { id:'lotte',   name:'Lotte Center Cầu Giấy', addr:'54 Liễu Giai, Ba Đình, Hà Nội',
    lat:21.0318, lng:105.8130, total:200, avail:18, type:'basement', ev:true,
    hours:'06:00–23:00', rate:22000, cap:130000 },
  { id:'trangtien', name:'Tràng Tiền Plaza', addr:'24 Hai Bà Trưng, Hoàn Kiếm, Hà Nội',
    lat:21.0245, lng:105.8528, total:80, avail:5, type:'surface', ev:false,
    hours:'07:00–22:00', rate:25000, cap:140000 },
  { id:'nhon',    name:'Nhổn Metro Park & Ride', addr:'Quốc lộ 32, Bắc Từ Liêm, Hà Nội',
    lat:21.0532, lng:105.7345, total:300, avail:210, type:'surface', ev:true,
    hours:'05:00–24:00', rate:10000, cap:60000 },
  { id:'opera',   name:'Hanoi Opera House Curbside', addr:'01 Tràng Tiền, Hoàn Kiếm, Hà Nội',
    lat:21.0240, lng:105.8578, total:40, avail:12, type:'curbside', ev:false,
    hours:'07:00–22:00', rate:18000, cap:110000 },
  { id:'daewoo',  name:'Hanoi Daewoo Hotel', addr:'360 Kim Mã, Ba Đình, Hà Nội',
    lat:21.0305, lng:105.8205, total:150, avail:60, type:'basement', ev:true,
    hours:'06:00–22:00', rate:21000, cap:125000 },
];

function loadDB(){
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      reservations: {},
      sessions: {},
      invoices: [],
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { reservations:{}, sessions:{}, invoices:[] };
  }
}

function saveDB(db){
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/* ============================================================
   PRICING (Decision 5794 aware)
   ============================================================ */
const HANOI_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

function isPeak(date = new Date()){
  const parts = HANOI_TIME_FMT.formatToParts(date);
  const hh = Number(parts.find(p => p.type === 'hour').value);
  const mm = Number(parts.find(p => p.type === 'minute').value);
  const h = hh + mm/60;
  return (h >= 7 && h < 9) || (h >= 17 && h < 19.5);
}

function priceFor(facility, hours){
  const rate = facility.rate || 20000;
  const cap  = facility.cap  || 120000;
  const mult = isPeak() ? 1.5 : 0.7;
  return Math.min(Math.round(hours * rate * mult), cap);
}

/* ============================================================
   HELPERS
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));
const rid = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 10);
const findFacility = id => FACILITIES.find(f => f.id === id);
const PLATE_RE = /^[0-9A-Za-z\-\.]{6,12}$/;

/* ============================================================
   ROUTES
   ============================================================ */

/* List facilities (with live-ish availability) */
app.get('/api/facilities', async (req, res) => {
  await sleep(jitter(80, 200));
  const db = loadDB();
  // simulate occupancy drift so "live" feels alive
  const list = FACILITIES.map(f => {
    const drift = Math.floor(Math.random() * 5) - 2;
    const avail = Math.max(0, Math.min(f.total, f.avail + drift));
    return { ...f, avail };
  });
  res.json({ facilities: list, peak: isPeak(), serverTime: Date.now() });
});

/* Get single facility */
app.get('/api/facilities/:id', async (req, res) => {
  await sleep(jitter(60, 160));
  const f = findFacility(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.json({ ...f, peak: isPeak() });
});

/* Quote: price for X hours at facility Y */
app.get('/api/quote', async (req, res) => {
  await sleep(jitter(40, 120));
  const { facilityId, hours } = req.query;
  const f = findFacility(facilityId);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  const h = parseFloat(hours);
  if (!h || h < 0.5 || h > 8) return res.status(400).json({ error: 'Hours must be 0.5–8' });
  const total = priceFor(f, h);
  res.json({
    facilityId,
    hours: h,
    total,
    deposit: Math.round(total * 0.5),
    peak: isPeak(),
    cap: f.cap,
  });
});

/* Create reservation hold (30 min) */
app.post('/api/reservations', async (req, res) => {
  await sleep(jitter(150, 380));
  const { facilityId, hours, plate } = req.body || {};
  const f = findFacility(facilityId);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  if (!hours || hours < 0.5 || hours > 8) return res.status(400).json({ error: 'Invalid hours' });
  const cleanPlate = String(plate || '').trim().toUpperCase();
  if (!PLATE_RE.test(cleanPlate))
    return res.status(400).json({ error: 'Invalid plate format' });

  // simulate 10% "bay just got taken"
  if (Math.random() < 0.1) {
    return res.status(409).json({ error: 'Bay just got taken — try again' });
  }

  const now = Date.now();
  const total = priceFor(f, hours);
  const resv = {
    id: rid('res'),
    facilityId,
    facilityName: f.name,
    hours,
    plate: cleanPlate,
    total,
    deposit: Math.round(total * 0.5),
    status: 'held',
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
  };

  const db = loadDB();
  db.reservations[resv.id] = resv;
  saveDB(db);

  res.status(201).json({ ...resv, serverTime: now });
});

/* Cancel reservation */
app.delete('/api/reservations/:id', async (req, res) => {
  await sleep(jitter(60, 140));
  const db = loadDB();
  const r = db.reservations[req.params.id];
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  r.status = 'cancelled';
  saveDB(db);
  res.json({ ok: true });
});

/* Get reservation */
app.get('/api/reservations/:id', async (req, res) => {
  const db = loadDB();
  const r = db.reservations[req.params.id];
  if (!r) return res.status(404).json({ error: 'Not found' });
  const now = Date.now();
  if (r.status === 'held' && now > r.expiresAt) {
    r.status = 'expired';
    saveDB(db);
  }
  res.json({ ...r, serverTime: now });
});

/* Check in → convert reservation to session */
app.post('/api/sessions', async (req, res) => {
  await sleep(jitter(120, 280));
  const { reservationId, plate } = req.body || {};
  const db = loadDB();
  const r = db.reservations[reservationId];
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.status !== 'held') return res.status(400).json({ error: 'Reservation not active' });
  if (Date.now() > r.expiresAt) {
    r.status = 'expired';
    saveDB(db);
    return res.status(410).json({ error: 'Reservation expired' });
  }

  let finalPlate = r.plate;
  if (plate !== undefined && plate !== null && String(plate).trim() !== '') {
    const cleanPlate = String(plate).trim().toUpperCase();
    if (!PLATE_RE.test(cleanPlate)) return res.status(400).json({ error: 'Invalid plate format' });
    finalPlate = cleanPlate;
    r.plate = cleanPlate;
  }

  const f = findFacility(r.facilityId);
  const now = Date.now();
  const session = {
    id: rid('ses'),
    facilityId: r.facilityId,
    facilityName: r.facilityName,
    plate: finalPlate,
    bay: 'A' + Math.floor(10 + Math.random() * 80),
    startTs: now,
    plannedHours: r.hours,
    extendedMs: 0,
    rate: f.rate,
    cap: f.cap,
    deposit: r.deposit,
  };
  db.sessions[session.id] = session;
  r.status = 'converted';
  saveDB(db);

  res.status(201).json({ ...session, serverTime: now });
});

/* Get session (for refreshing after reload) */
app.get('/api/sessions/:id', async (req, res) => {
  const db = loadDB();
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ...s, serverTime: Date.now() });
});

/* Extend session (+30 min or custom minutes) */
app.post('/api/sessions/:id/extend', async (req, res) => {
  await sleep(jitter(80, 200));
  const { minutes = 30 } = req.body || {};
  const db = loadDB();
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  s.extendedMs += minutes * 60 * 1000;
  saveDB(db);
  res.json({ ...s, serverTime: Date.now() });
});

/* Checkout: stop session, compute final, issue invoice */
app.post('/api/sessions/:id/checkout', async (req, res) => {
  await sleep(jitter(200, 420));
  const { method = 'MoMo' } = req.body || {};
  const db = loadDB();
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });

  const elapsedMs = Date.now() - s.startTs + s.extendedMs;
  const elapsedHours = Math.max(0.5, elapsedMs / 3_600_000);
  const total = priceFor({ rate:s.rate, cap:s.cap }, elapsedHours);
  const final = Math.max(0, total - s.deposit);

  const invoice = {
    id: rid('inv'),
    lookupCode:
      'PE-' + new Date().getFullYear() + '-' +
      Math.floor(1000 + Math.random() * 9000) + '-' +
      Math.floor(1000 + Math.random() * 9000),
    decree: '123/2020/NĐ-CP',
    issuedAt: new Date().toISOString(),
    facilityName: s.facilityName,
    plate: s.plate,
    method,
    elapsedHours,
    total,
    deposit: s.deposit,
    final,
  };

  db.invoices.push(invoice);
  delete db.sessions[req.params.id];
  saveDB(db);

  res.json({ ok: true, invoice, session: s });
});

/* Invoice lookup */
app.get('/api/invoices/:id', async (req, res) => {
  const db = loadDB();
  const inv = db.invoices.find(i => i.id === req.params.id || i.lookupCode === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

/* Health */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* Fallback to index.html for SPA-style routing if needed */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`ParkEase running on :${PORT}`));