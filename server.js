const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const DB_FILE = path.join(__dirname, 'data.json');

// ---------- storage ----------
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('Could not read data.json, starting fresh:', e.message);
    }
  }
  return {
    nextWorkerId: 1,
    nextPenaltyId: 1,
    workers: [],
    events: [],
    penalties: [],
    states: {},
    settings: { travelMinutes: 30, penaltyHours: 1, hourlyRate: 0, currency: '\u00a3' }
  };
}

let db = loadDB();

function save() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db), 'utf8');
  } catch (e) {
    console.error('Could not write data.json:', e.message);
  }
}

// ---------- helpers ----------
function findWorker(id) {
  return db.workers.find(w => w.id === Number(id));
}

function getState(id) {
  id = Number(id);
  if (!db.states[id]) {
    db.states[id] = { state: 'off', jobStart: null, deadline: null, penaltyLogged: false };
  }
  return db.states[id];
}

function logEvent(workerId, type, meta) {
  const w = findWorker(workerId);
  db.events.push({
    id: db.events.length + 1,
    worker_id: Number(workerId),
    name: w ? w.name : 'Unknown',
    type,
    t: Date.now(),
    meta: meta || null
  });
}

function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

// Lazily flip a traveling worker to "late" and log a one-time penalty.
function checkLate(workerId) {
  const st = getState(workerId);
  if (st.state === 'traveling' && st.deadline && Date.now() > st.deadline && !st.penaltyLogged) {
    const w = findWorker(workerId);
    const minutesLate = Math.max(1, Math.round((Date.now() - st.deadline) / 60000));
    db.penalties.push({
      id: db.nextPenaltyId++,
      worker_id: Number(workerId),
      worker_name: w ? w.name : 'Unknown',
      minutes_late: minutesLate,
      hours_docked: db.settings.penaltyHours,
      waived: false,
      created_at: Date.now()
    });
    st.state = 'late';
    st.penaltyLogged = true;
    logEvent(workerId, 'went overdue');
    save();
  }
}

function summary(workerId) {
  workerId = Number(workerId);
  const finished = db.events.filter(e => e.worker_id === workerId && e.type === 'finish-job' && isToday(e.t));
  const jobsDone = finished.length;
  const workedMinutes = finished.reduce((s, e) => s + (e.meta && e.meta.duration ? e.meta.duration : 0), 0);
  const penalties = db.penalties.filter(p => p.worker_id === workerId && !p.waived && isToday(p.created_at)).length;
  return { jobsDone, workedMinutes, penalties };
}

// ---------- worker-facing API ----------
app.get('/api/workers', (req, res) => {
  res.json(db.workers.filter(w => !w.removed).map(w => ({ id: w.id, name: w.name })));
});

app.get('/api/me/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!findWorker(id)) return res.status(404).json({ error: 'not found' });
  checkLate(id);
  const st = getState(id);
  res.json({ state: st.state, deadline: st.deadline, serverNow: Date.now(), summary: summary(id) });
});

app.post('/api/clock-in', (req, res) => {
  const id = req.body.workerId;
  if (!findWorker(id)) return res.status(404).json({ error: 'not found' });
  const st = getState(id);
  st.state = 'idle'; st.jobStart = null; st.deadline = null; st.penaltyLogged = false;
  logEvent(id, 'clocked in'); save();
  res.json({ ok: true });
});

app.post('/api/start-job', (req, res) => {
  const id = req.body.workerId;
  if (!findWorker(id)) return res.status(404).json({ error: 'not found' });
  const st = getState(id);
  st.state = 'working'; st.jobStart = Date.now(); st.deadline = null; st.penaltyLogged = false;
  logEvent(id, 'started a job'); save();
  res.json({ ok: true });
});

app.post('/api/finish-job', (req, res) => {
  const id = req.body.workerId;
  if (!findWorker(id)) return res.status(404).json({ error: 'not found' });
  const st = getState(id);
  const duration = st.jobStart ? Math.round((Date.now() - st.jobStart) / 60000) : 0;
  logEvent(id, 'finished a job', { duration });
  st.state = 'traveling';
  st.deadline = Date.now() + db.settings.travelMinutes * 60000;
  st.jobStart = null; st.penaltyLogged = false;
  save();
  res.json({ ok: true });
});

app.post('/api/clock-out', (req, res) => {
  const id = req.body.workerId;
  if (!findWorker(id)) return res.status(404).json({ error: 'not found' });
  const st = getState(id);
  st.state = 'off'; st.jobStart = null; st.deadline = null; st.penaltyLogged = false;
  logEvent(id, 'clocked out'); save();
  res.json({ ok: true });
});

// ---------- admin API ----------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  res.json({ ok: req.body.pin === ADMIN_PIN });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const crew = db.workers.filter(w => !w.removed).map(w => {
    checkLate(w.id);
    const st = getState(w.id);
    return { id: w.id, name: w.name, state: st.state, deadline: st.deadline, summary: summary(w.id) };
  });
  res.json({ serverNow: Date.now(), settings: db.settings, crew });
});

app.get('/api/admin/penalties', requireAdmin, (req, res) => {
  res.json([...db.penalties].sort((a, b) => b.created_at - a.created_at));
});

app.get('/api/admin/log', requireAdmin, (req, res) => {
  res.json(db.events.filter(e => isToday(e.t)).sort((a, b) => b.t - a.t));
});

app.post('/api/admin/workers', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const worker = { id: db.nextWorkerId++, name, removed: false };
  db.workers.push(worker); save();
  res.json({ ok: true, worker });
});

app.post('/api/admin/workers/:id/remove', requireAdmin, (req, res) => {
  const w = findWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  w.removed = true; save();
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { travel_minutes, penalty_hours, hourly_rate, currency } = req.body;
  if (travel_minutes !== undefined) db.settings.travelMinutes = Number(travel_minutes);
  if (penalty_hours !== undefined) db.settings.penaltyHours = Number(penalty_hours);
  if (hourly_rate !== undefined) db.settings.hourlyRate = Number(hourly_rate);
  if (currency !== undefined) db.settings.currency = currency;
  save();
  res.json({ ok: true });
});

app.post('/api/admin/penalties/:id/waive', requireAdmin, (req, res) => {
  const p = db.penalties.find(x => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  p.waived = !!req.body.waived; save();
  res.json({ ok: true });
});

// ---------- static pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log('Crew Clock running on port ' + PORT));
