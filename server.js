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
    hours:'06:00–23:00', rate:20000, cap:120000,
    maxHeight:'2.1m', carEntrance:'Cổng ô tô: Mặt phố Bùi Thị Xuân',
    entryNote:'Camera AI nhận diện biển số & Barie tự động B2-B4' },
  { id:'lotte',   name:'Lotte Center Cầu Giấy', addr:'54 Liễu Giai, Ba Đình, Hà Nội',
    lat:21.0318, lng:105.8130, total:200, avail:18, type:'basement', ev:true,
    hours:'06:00–23:00', rate:22000, cap:130000,
    maxHeight:'2.2m', carEntrance:'Cổng ô tô: Mặt phố Đào Tấn & Liễu Giai',
    entryNote:'Làn riêng ô tô B3-B5 có hướng dẫn đỗ xe điện tử' },
  { id:'trangtien', name:'Tràng Tiền Plaza', addr:'24 Hai Bà Trưng, Hoàn Kiếm, Hà Nội',
    lat:21.0245, lng:105.8528, total:80, avail:5, type:'surface', ev:false,
    hours:'07:00–22:00', rate:25000, cap:140000,
    maxHeight:'Không giới hạn', carEntrance:'Lối vào ô tô: Mặt phố Hai Bà Trưng',
    entryNote:'Bãi ngoài trời trung tâm, bảo vệ hướng dẫn vị trí' },
  { id:'nhon',    name:'Nhổn Metro Park & Ride', addr:'Quốc lộ 32, Bắc Từ Liêm, Hà Nội',
    lat:21.0532, lng:105.7345, total:300, avail:210, type:'surface', ev:true,
    hours:'05:00–24:00', rate:10000, cap:60000,
    maxHeight:'Không giới hạn', carEntrance:'Làn ô tô riêng: Cổng chính QL32 ga Metro',
    entryNote:'Trạm sạc nhanh VinFast + Bãi trung chuyển xe ô tô' },
  { id:'opera',   name:'Hanoi Opera House Curbside', addr:'01 Tràng Tiền, Hoàn Kiếm, Hà Nội',
    lat:21.0240, lng:105.8578, total:40, avail:12, type:'curbside', ev:false,
    hours:'07:00–22:00', rate:18000, cap:110000,
    maxHeight:'Không giới hạn', carEntrance:'Điểm đỗ ô tô ven đường: Vườn hoa Nhà hát Lớn',
    entryNote:'Đỗ xe ven đường thanh toán điện tử không dùng tiền mặt' },
  { id:'daewoo',  name:'Hanoi Daewoo Hotel', addr:'360 Kim Mã, Ba Đình, Hà Nội',
    lat:21.0305, lng:105.8205, total:150, avail:60, type:'basement', ev:true,
    hours:'06:00–22:00', rate:21000, cap:125000,
    maxHeight:'2.0m', carEntrance:'Lối xuống hầm ô tô: Cổng số 2 mặt đường Kim Mã',
    entryNote:'Camera ANPR tự động B1-B2 & Trạm sạc ô tô điện' },
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
   PRICING (Decision 5794 & Report Pricing Model)
   ============================================================ */
const BASE_BARRIER_FEE = 10000; // Phí mở barie tối thiểu (Flag-fall barrier unlock fee)

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

function priceFor(facility, hours, peak = isPeak()){
  const rate = facility.rate || 20000;
  const cap  = facility.cap  || 120000;
  const mult = peak ? 1.5 : 0.7;
  const calculated = Math.round(hours * rate * mult);
  // Mức sàn là phí mở barie tối thiểu (áp dụng cả khi vào bãi rồi ra ngay)
  const withMin = Math.max(BASE_BARRIER_FEE, calculated);
  return Math.min(withMin, cap);
}

/* ============================================================
   HELPERS
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));
const rid = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 10);
const findFacility = id => FACILITIES.find(f => f.id === id);
const PLATE_RE = /^[0-9A-Za-z\-\.]{6,12}$/;

function availFor(db, f, now = Date.now()){
  const held = Object.values(db.reservations)
    .filter(r => r.facilityId === f.id && r.status === 'held' && r.expiresAt > now).length;
  const active = Object.values(db.sessions)
    .filter(s => s.facilityId === f.id).length;
  return Math.max(0, f.avail - held - active);
}

/* ============================================================
   ROUTES
   ============================================================ */

/* List facilities (real remaining bays after active holds & sessions) */
app.get('/api/facilities', async (req, res) => {
  await sleep(jitter(80, 200));
  const db = loadDB();
  const now = Date.now();
  const list = FACILITIES.map(f => ({ ...f, avail: availFor(db, f, now) }));
  res.json({ facilities: list, peak: isPeak(), serverTime: now });
});

/* Get single facility */
app.get('/api/facilities/:id', async (req, res) => {
  await sleep(jitter(60, 160));
  const f = findFacility(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const db = loadDB();
  const now = Date.now();
  res.json({ ...f, avail: availFor(db, f, now), peak: isPeak(), serverTime: now });
});

/* Quote: price for X hours/minutes at facility Y */
app.get('/api/quote', async (req, res) => {
  await sleep(jitter(40, 120));
  const { facilityId } = req.query;
  const f = findFacility(facilityId);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  const rawH = req.query.hours;
  const rawM = req.query.minutes;
  const h = rawM ? (Number(rawM) / 60) : parseFloat(rawH);
  if (!h || h < 0.25 || h > 12) return res.status(400).json({ error: 'Duration must be 0.25–12 hours (15m–12h)' });
  const peak = isPeak();
  const mult = peak ? 1.5 : 0.7;
  const rawCalculated = Math.round(h * f.rate * mult);
  const total = priceFor(f, h, peak);
  res.json({
    facilityId,
    hours: Number(h.toFixed(2)),
    minutes: Math.round(h * 60),
    rate: f.rate,
    mult,
    peak,
    barrierBaseFee: BASE_BARRIER_FEE,
    rawCalculated,
    total,
    deposit: Math.round(total * 0.5),
    cap: f.cap,
  });
});

/* Create reservation hold (30 min) */
app.post('/api/reservations', async (req, res) => {
  await sleep(jitter(150, 380));
  const { facilityId, hours, minutes, plate } = req.body || {};
  const f = findFacility(facilityId);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  const h = minutes ? (Number(minutes) / 60) : parseFloat(hours);
  if (!h || h < 0.25 || h > 12) return res.status(400).json({ error: 'Duration must be 0.25–12 hours (15m–12h)' });
  const cleanPlate = String(plate || '').trim().toUpperCase();
  if (!PLATE_RE.test(cleanPlate))
    return res.status(400).json({ error: 'Invalid plate format' });

  const now = Date.now();
  const db = loadDB();
  if (availFor(db, f, now) <= 0) {
    return res.status(409).json({ error: 'No free bays at this facility right now' });
  }

  const total = priceFor(f, h);
  const resv = {
    id: rid('res'),
    facilityId,
    facilityName: f.name,
    hours: Number(h.toFixed(2)),
    minutes: Math.round(h * 60),
    plate: cleanPlate,
    total,
    deposit: Math.round(total * 0.5),
    status: 'held',
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
  };

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
  if (r.status === 'held') {
    r.status = 'cancelled';
    saveDB(db);
  }
  res.json({ ok: true });
});

function issueForfeitInvoice(db, r, now = Date.now()){
  const code = 'PE-NOSHOW-' + new Date(now).getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000);
  const operatorShare = Math.round(r.deposit * 0.7);
  const platformShare = Math.round(r.deposit * 0.3);
  const invoice = {
    id: rid('inv'),
    lookupCode: code,
    decree: '123/2020/NĐ-CP',
    type: 'no_show_penalty',
    status: 'forfeited',
    forfeited: true,
    issuedAt: new Date(now).toISOString(),
    facilityName: r.facilityName,
    plate: r.plate,
    method: 'Khấu trừ tiền cọc (No-show fee)',
    elapsedMinutes: 30,
    elapsedHours: 0.5,
    rate: 0,
    surgeMult: 1,
    isPeak: false,
    barrierBaseFee: 0,
    isBarrierBaseFeeApplied: false,
    total: r.deposit,
    deposit: r.deposit,
    final: r.deposit,
    operatorShare,
    platformShare,
    note: 'Thu hồi 100% tiền đặt cọc giữ chỗ do quá 30 phút không đến nhận chỗ (Chính sách No-show trong Báo cáo EXE101 Mục 3.2: 70% đền bù chủ bãi, 30% phí xử lý ParkEase)',
    formula: `Thu hồi cọc: ${r.deposit.toLocaleString('vi-VN')} VND (Chủ bãi 70%: ${operatorShare.toLocaleString('vi-VN')}đ, ParkEase 30%: ${platformShare.toLocaleString('vi-VN')}đ)`,
  };
  db.invoices.push(invoice);
  return invoice;
}

/* Get reservation */
app.get('/api/reservations/:id', async (req, res) => {
  const db = loadDB();
  const r = db.reservations[req.params.id];
  if (!r) return res.status(404).json({ error: 'Not found' });
  const now = Date.now();
  if (r.status === 'held' && now > r.expiresAt) {
    r.status = 'forfeited';
    r.forfeitedAt = now;
    issueForfeitInvoice(db, r, now);
    saveDB(db);
  }
  res.json({ ...r, serverTime: now });
});

/* Forfeit reservation deposit (No-show policy) */
app.post('/api/reservations/:id/forfeit', async (req, res) => {
  const db = loadDB();
  const r = db.reservations[req.params.id];
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.status !== 'held') return res.status(400).json({ error: 'Reservation not active' });
  const now = Date.now();
  r.status = 'forfeited';
  r.forfeitedAt = now;
  const inv = issueForfeitInvoice(db, r, now);
  saveDB(db);
  res.json({ ok: true, forfeited: true, reservation: r, invoice: inv });
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
  const rawMin = (req.body || {}).minutes;
  const minutes = rawMin === undefined ? 30 : Number(rawMin);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 240) {
    return res.status(400).json({ error: 'Extension must be 15–240 minutes' });
  }
  const db = loadDB();
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  s.extendedMs += Math.round(minutes) * 60 * 1000;
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

  const now = Date.now();
  const elapsedMs = Math.max(0, now - s.startTs);
  const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const elapsedHours = Number((elapsedMs / 3_600_000).toFixed(2));
  const peak = isPeak(new Date(now));
  const mult = peak ? 1.5 : 0.7;

  // Pricing model:
  // 1. Phí theo giờ có hệ số cao/thấp điểm
  const rawCalculated = Math.round((elapsedMs / 3_600_000) * s.rate * mult);
  // 2. Vào ra ngay (< 5 phút hoặc 0 đồng) -> thu phí mở barie tối thiểu (như mở cửa taxi)
  const isBarrierBaseFeeApplied = rawCalculated < BASE_BARRIER_FEE;
  const total = Math.min(Math.max(BASE_BARRIER_FEE, rawCalculated), s.cap);
  // 3. Khấu trừ 100% tiền cọc đã đóng trước
  const depositCredit = s.deposit || 0;
  const final = Math.max(0, total - depositCredit);

  const invoice = {
    id: rid('inv'),
    lookupCode:
      'PE-' + new Date(now).getFullYear() + '-' +
      Math.floor(1000 + Math.random() * 9000) + '-' +
      Math.floor(1000 + Math.random() * 9000),
    decree: '123/2020/NĐ-CP',
    issuedAt: new Date(now).toISOString(),
    facilityName: s.facilityName,
    plate: s.plate,
    method,
    elapsedMinutes,
    elapsedHours,
    rate: s.rate,
    surgeMult: mult,
    isPeak: peak,
    barrierBaseFee: BASE_BARRIER_FEE,
    isBarrierBaseFeeApplied,
    barrierBaseFeeApplied: isBarrierBaseFeeApplied,
    rawCalculated,
    total,
    deposit: depositCredit,
    final,
    formula: isBarrierBaseFeeApplied
      ? `Áp dụng phí mở barie tối thiểu ${BASE_BARRIER_FEE.toLocaleString('vi-VN')} đ (vào ra ngay tức khắc < thời gian đỗ tối thiểu)`
      : `Min(Max(${BASE_BARRIER_FEE}, ${elapsedHours}h × ${s.rate.toLocaleString('vi-VN')}đ × ${mult}), ${s.cap.toLocaleString('vi-VN')}đ) = ${total.toLocaleString('vi-VN')} đ`,
  };

  db.invoices.push(invoice);
  delete db.sessions[req.params.id];
  saveDB(db);

  res.json({ ok: true, invoice, session: s });
});

/* Invoices list */
app.get('/api/invoices', (req, res) => {
  const db = loadDB();
  let list = db.invoices || [];
  if (req.query.plate) {
    const p = req.query.plate.trim().toUpperCase();
    list = list.filter(i => (i.plate || '').toUpperCase() === p);
  }
  const recent = [...list].reverse().slice(0, 30);
  res.json({ ok: true, invoices: recent });
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