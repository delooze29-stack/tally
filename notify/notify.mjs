// Tally notification sender. GitHub runs this every 15 minutes (.github/workflows/notify.yml).
// It only sends to players who turned notifications on in the game, and only what they chose:
//   codes  - "new code ready" at 6am and 8pm UK time
//   mine   - someone finished one of your challenges
//   daily  - 6pm round-up of challenges waiting for you
// It does nothing until the FIREBASE_SERVICE_ACCOUNT secret is added to the GitHub repo.
import admin from 'firebase-admin';
import { puzzle, roundAt, londonParts } from './game.mjs';

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!SA) { console.log('Notifications are not set up yet (no FIREBASE_SERVICE_ACCOUNT secret). Nothing to do.'); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
const fcm = admin.messaging();
const FV = admin.firestore.FieldValue;

import { readFileSync } from 'node:fs';
// Links point at the game's own web address: the custom domain in the CNAME file once there is one.
let HOME = 'https://delooze29-stack.github.io/tally/';
try { const d = readFileSync(new URL('../CNAME', import.meta.url), 'utf8').trim(); if (d) HOME = `https://${d}/`; } catch (e) {}
const SITE = HOME + (process.env.TALLY_PATH || '');
const TEST = (process.env.TEST_NICKNAME || '').trim().toLowerCase();
const now = Date.now();
const R = roundAt(now);
const lp = londonParts(now);
const minute = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', minute: '2-digit' }).format(new Date(now));

const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);
let sent = 0;

async function send(doc, { title, body, tag, url = SITE, ttl = 6 * 3600 }) {
  const tokens = (doc.tokens || []).filter(Boolean);
  if (!tokens.length) return;
  const res = await fcm.sendEachForMulticast({
    tokens,
    data: { title, body, tag, url },
    webpush: { headers: { Urgency: 'high', TTL: String(ttl) }, fcmOptions: { link: url } },
  });
  sent += res.successCount;
  const bad = res.responses.map((r, i) => (r.error && BAD_TOKEN.has(r.error.code) ? tokens[i] : null)).filter(Boolean);
  if (bad.length) await db.collection('push').doc(doc.uid).update({ tokens: FV.arrayRemove(...bad) });
  res.responses.forEach((r, i) => { if (r.error) console.warn(`Phone ${i + 1} of ${doc.name}: ${r.error.code}${BAD_TOKEN.has(r.error.code) ? ' (removed, they need to turn notifications on again)' : ''}`); });
}

// Everyone's notification settings are only loaded when something is due, to keep
// database reads low (this runs 96 times a day).
let pushCache = null;
async function players() {
  if (!pushCache) pushCache = (await db.collection('push').get()).docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(d => (d.tokens || []).length);
  return pushCache;
}
console.log(`Code No. ${R}, UK ${String(lp.h).padStart(2, '0')}:${String(minute).padStart(2, '0')}.`);

// ---- Test: a one-off notification to one player, from the Actions tab ----
if (TEST) {
  const all = await players();
  const doc = all.find(d => (d.name || '').toLowerCase() === TEST);
  if (!doc) { console.log(`No player called "${TEST}" has notifications on. Players with them on: ${all.map(d => d.name).join(', ') || 'none'}`); process.exit(0); }
  await send(doc, { title: 'Tally test 🔔', body: 'Notifications are working. See you at the next code!', tag: 'test' });
  console.log(`Test for ${doc.name}: delivered to ${sent} of ${(doc.tokens || []).length} phone(s).`);
  process.exit(0);
}

const metaRef = db.doc('meta/push');
const meta = (await metaRef.get()).data() || {};
const update = {};

// ---- 1. New code at 6am and 8pm ----
// Sent once per code, within 90 minutes of it starting (GitHub's timer can run a little late).
const inWindow = lp.h === 6 || lp.h === 20 || ((lp.h === 7 || lp.h === 21) && minute < 30);
if (meta.lastRound == null) {
  update.lastRound = R;
} else if (R > meta.lastRound) {
  if (inWindow) {
    const morning = R % 2 === 1;
    for (const d of (await players()).filter(d => d.codes !== false)) {
      await send(d, {
        title: 'A new Tally code is ready 🔢',
        body: `Tally No. ${R} is ready. Can you crack it in 7?`,
        tag: 'code', ttl: 4 * 3600,
      });
    }
    console.log(`New code No. ${R} sent.`);
  }
  update.lastRound = R;
}

// ---- 2. Someone finished one of your challenges ----
const since = meta.lastAttempt || admin.firestore.Timestamp.fromMillis(now - 30 * 60e3);
const recent = (await db.collection('attempts').where('ts', '>', since).get()).docs.map(d => d.data());
let newest = since;
for (const a of recent) {
  if (a.ts && a.ts.toMillis() > newest.toMillis()) newest = a.ts;
  if (a.status !== 'done') continue;
  const setter = (await players()).find(d => d.uid === a.setter && d.mine !== false);
  if (!setter) continue;
  const n = (a.g || []).length, tag = `ch-${a.ch}-${a.uid}`, mine = SITE + '#mine';
  let msg = null;
  if (a.won && !a.late) msg = a.pay === false
    ? { title: `${a.name} cracked your code`, body: `You didn't have the points to pay out. It's paused: open Tally to re-open it or close it.`, tag, url: mine }
    : { title: `${a.name} cracked your code 😬`, body: `They got it in ${n} and take ${a.stake} pts. It's paused: open Tally to re-open it or close it.`, tag, url: mine };
  else if (a.won && a.late && a.pay) msg = { title: `${a.name} cracked your code too`, body: `They take ${a.stake} pts from you.`, tag, url: mine };
  else if (!a.won && !a.late) msg = { title: `${a.name} couldn't crack your code 🎉`, body: `You win ${a.stake} pts. Nice code!`, tag, url: mine };
  if (msg) await send(setter, msg);
}
if (newest !== since) update.lastAttempt = newest;

// ---- 2b. League invites ----
const invSince = meta.lastInvite || admin.firestore.Timestamp.fromMillis(now - 30 * 60e3);
const invites = (await db.collection('invites').where('ts', '>', invSince).get()).docs.map(d => d.data());
let invNewest = invSince;
for (const v of invites) {
  if (v.ts && v.ts.toMillis() > invNewest.toMillis()) invNewest = v.ts;
  const who = (await players()).find(d => d.uid === v.uid && d.mine !== false);
  if (who) await send(who, { title: '🏆 League invite', body: `${v.from} invited you to join "${v.leagueName}". Open Tally to join.`, tag: `inv-${v.league}`, url: SITE + '#leagues' });
}
if (invNewest !== invSince) update.lastInvite = invNewest;

// ---- 2c. Reported chat comments: tell the moderator (the player called Mathew) ----
const repSince = meta.lastReport || admin.firestore.Timestamp.fromMillis(now - 30 * 60e3);
const reports = (await db.collection('reports').where('ts', '>', repSince).get()).docs.map(d => d.data());
if (reports.length) {
  let repNewest = repSince;
  reports.forEach(r => { if (r.ts && r.ts.toMillis() > repNewest.toMillis()) repNewest = r.ts; });
  update.lastReport = repNewest;
  const modDoc = await db.collection('names').doc('mathew').get();
  const mod = modDoc.exists && (await players()).find(d => d.uid === modDoc.data().uid);
  const r = reports[reports.length - 1];
  if (mod) await send(mod, {
    title: reports.length === 1 ? '⚑ A chat comment was reported' : `⚑ ${reports.length} chat comments were reported`,
    body: `${r.name}: "${String(r.text).slice(0, 80)}"`, tag: 'reports', url: SITE + '#chat'
  });
}

// ---- 2d. Player milestones: tell the owner when it's time to review the safety risk assessment ----
// Checked once a day at 6pm with a cheap count (no player documents read).
if (lp.h >= 18 && lp.h < 20 && meta.lastCountDay !== `${lp.y}-${lp.m}-${lp.d}`) {
  update.lastCountDay = `${lp.y}-${lp.m}-${lp.d}`;
  const n = (await db.collection('players').count().get()).data().count;
  const step = [100, 250, 500, 1000, 2500, 5000, 10000].filter(x => n >= x).pop() || 0;
  if (step > (meta.lastMilestone || 0)) {
    update.lastMilestone = step;
    const modDoc = await db.collection('names').doc('mathew').get();
    const mod = modDoc.exists && (await players()).find(d => d.uid === modDoc.data().uid);
    if (mod) await send(mod, {
      title: `🎉 Tally has passed ${step} players`,
      body: step >= 1000 ? 'Time to register the name as a trade mark, look at setting up as a business, and review your safety risk assessment.' : step >= 500 ? 'Time to review your online safety risk assessment, as it says in the doc.' : 'Nice one! Keep an eye on the chats as it grows.',
      tag: 'milestone', url: SITE
    });
  }
}

// ---- 4. Best on each code: +5 pts, and +10 more for being best on both codes of a day ----
// A code closes when the next one starts. Best = cracked it in the fewest goes, then the fastest time.
// Exact ties all get the bonus. Players on a fair-play hold can't win it. Written to the "bonus" collection,
// which the game adds into All time, league All time, Today and the weekly divisions (not the averages).
const R_BASE = 100000, LUCKY_HOLD = 3, CODE_BONUS = 5, DAY_BONUS = 10;
const dayOf = r => Math.floor((r - 1) / 2);              // rounds 2d+1 (6am) and 2d+2 (8pm) belong to day d
async function heldSet(rkey) {
  const [q, cl] = await Promise.all([db.collection('scores').where('day', '>=', rkey - 13).where('day', '<=', rkey).get(), db.collection('clears').get()]);
  const cleared = {}; cl.docs.forEach(d => cleared[d.id] = +d.data().day || 0);
  const n = {}; q.docs.forEach(d => { const x = d.data(); if (x.won && x.guesses === 1 && x.day - R_BASE > (cleared[x.uid] || 0)) n[x.uid] = (n[x.uid] || 0) + (x.secs > 0 && x.secs < 10 ? 2 : 1); });
  return new Set(Object.keys(n).filter(u => n[u] >= LUCKY_HOLD));
}
async function codeWinners(r) {
  const rkey = R_BASE + r, held = await heldSet(rkey);
  const sc = (await db.collection('scores').where('day', '==', rkey).get()).docs.map(d => d.data()).filter(x => x.won && !held.has(x.uid) && !(x.secs > 0 && x.secs < 3 * x.guesses));   // too fast to be real: no bonus
  if (!sc.length) return [];
  const key = x => [x.guesses, x.secs || 1e9];
  sc.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  const best = key(sc[0]);
  return sc.filter(x => key(x)[0] === best[0] && key(x)[1] === best[1]);
}
const bonusStart = meta.lastBonusRound != null ? meta.lastBonusRound + 1 : R - 1;
for (let r = Math.max(1, bonusStart); r < R; r++) {
  const win = await codeWinners(r), rkey = R_BASE + r;
  for (const x of win) {
    await db.collection('bonus').doc(`c${rkey}_${x.uid}`).set({ kind: 'code', round: rkey, day: dayOf(r), uid: x.uid, name: x.name, pts: CODE_BONUS, guesses: x.guesses, secs: x.secs || 0, ts: x.ts || FV.serverTimestamp() });
    const who = (await players()).find(d => d.uid === x.uid && d.codes !== false);
    if (who) await send(who, { title: `⭐ Best on code No. ${r}! +${CODE_BONUS} pts`, body: `Fewest goes${x.secs ? ' and fastest time' : ''}: ${x.guesses}/7${x.secs ? ' in ' + Math.floor(x.secs / 60) + ':' + String(x.secs % 60).padStart(2, '0') : ''}.`, tag: `bonus-${rkey}` });
  }
  console.log(`Code No. ${r} best: ${win.map(x => x.name).join(', ') || 'nobody cracked it'}.`);
  if (r % 2 === 0) {                                     // the evening code just closed: check the whole day
    const morning = (await db.collection('bonus').where('round', '==', rkey - 1).get()).docs.map(d => d.data().uid);
    for (const x of win.filter(x => morning.includes(x.uid))) {
      await db.collection('bonus').doc(`d${dayOf(r)}_${x.uid}`).set({ kind: 'day', day: dayOf(r), round: rkey, uid: x.uid, name: x.name, pts: DAY_BONUS, ts: x.ts || FV.serverTimestamp() });
      const who = (await players()).find(d => d.uid === x.uid && d.codes !== false);
      if (who) await send(who, { title: `🌟 Best on both codes yesterday! +${DAY_BONUS} bonus`, body: `That's ${2 * CODE_BONUS + DAY_BONUS} bonus points for the day.`, tag: `daybonus-${dayOf(r)}` });
      console.log(`Day ${dayOf(r)} double: ${x.name}.`);
    }
  }
  update.lastBonusRound = r;
}

// ---- 5. Weekly divisions: Division 1 has 5 players, Division 2 is everyone else who plays ----
// Weeks run Monday to Sunday (UK). When a new week starts (Monday 6am, once Sunday's 8pm code has closed),
// the bottom of Division 1 swaps with the top of Division 2. Points = code points + bonuses that week.
const weekOf = d => Math.floor((d + 4) / 7);             // day 0 (Fri 23 Oct 2026) is in week 0, Mon 26 Oct starts week 1
const weekRounds = w => { const d0 = 7 * w - 4; return [R_BASE + 2 * d0 + 1, R_BASE + 2 * (d0 + 6) + 2]; };
const DIV1 = 5;
async function weekTable(w) {
  const [a, b] = weekRounds(w);
  const [sc, bo, held] = await Promise.all([
    db.collection('scores').where('day', '>=', a).where('day', '<=', b).get(),
    db.collection('bonus').where('round', '>=', a).where('round', '<=', b).get(),
    heldSet(b)]);
  const t = {};
  const row = (uid, name) => t[uid] || (t[uid] = { uid, name, pts: 0, codes: 0 });
  sc.docs.forEach(d => { const x = d.data(); if (held.has(x.uid)) return; const r = row(x.uid, x.name); r.pts += x.points || 0; r.codes++; });
  bo.docs.forEach(d => { const x = d.data(); if (held.has(x.uid)) return; row(x.uid, x.name).pts += x.pts || 0; });
  return t;
}
const wkNow = weekOf(dayOf(R));
const wkRef = db.collection('weekly').doc(`w${wkNow}`);
if (!(await wkRef.get()).exists) {
  const prevDoc = await db.collection('weekly').doc(`w${wkNow - 1}`).get();
  let div1, moves = null;
  if (!prevDoc.exists) {
    // First week: the top 5 on the All time table (code points + challenges + bonuses), not counting anyone on hold.
    const [ps, atts, bon, held] = await Promise.all([db.collection('players').get(), db.collection('attempts').get(), db.collection('bonus').get(), heldSet(R_BASE + R)]);
    const extra = {};
    atts.docs.forEach(d => { const a = d.data(), o = a.status !== 'done' ? 'playing' : a.won ? ((a.late ? a.pay === true : a.pay !== false) ? 'win' : 'void') : (a.late ? 'lateloss' : 'loss');
      extra[a.uid] = (extra[a.uid] || 0) + (o === 'win' ? a.stake : o === 'void' ? 0 : -a.stake);
      if (a.setter) extra[a.setter] = (extra[a.setter] || 0) + (o === 'win' ? -a.stake : o === 'loss' ? a.stake : 0); });
    bon.docs.forEach(d => { const b = d.data(); extra[b.uid] = (extra[b.uid] || 0) + (b.pts || 0); });
    div1 = ps.docs.map(d => ({ uid: d.id, name: d.data().name, pts: Math.max(0, (d.data().total || 0) + (extra[d.id] || 0)), played: d.data().played || 0 }))
      .filter(p => p.played > 0 && !held.has(p.uid)).sort((a, b) => b.pts - a.pts).slice(0, DIV1).map(({ uid, name }) => ({ uid, name }));
  } else {
    const prev = prevDoc.data(), t = await weekTable(wkNow - 1), inDiv1 = new Set(prev.div1.map(p => p.uid));
    const score = p => (t[p.uid] || { pts: 0, codes: 0 });
    const d1 = prev.div1.map(p => ({ ...p, ...score(p), name: (t[p.uid] || p).name })).sort((a, b) => b.pts - a.pts || b.codes - a.codes);
    const d2 = Object.values(t).filter(p => !inDiv1.has(p.uid) && p.codes > 0).sort((a, b) => b.pts - a.pts || b.codes - a.codes);
    div1 = d1.map(({ uid, name }) => ({ uid, name }));
    if (d2.length && d1.length >= DIV1) {
      const down = div1.pop(), up = { uid: d2[0].uid, name: d2[0].name };
      div1.push(up); moves = { promoted: up, relegated: down };
      const tell = async (u, title, body) => { const who = (await players()).find(d => d.uid === u.uid && d.codes !== false); if (who) await send(who, { title, body, tag: `div-${wkNow}`, url: SITE + '#divisions' }); };
      await tell(up, '🏅 Promoted to Division 1!', `You topped Division 2 last week. Can you stay up?`);
      await tell(down, '⬇️ Relegated to Division 2', `You finished bottom of Division 1 last week. Win Division 2 to go back up.`);
    } else if (d1.length < DIV1) {
      for (const p of d2) { if (div1.length >= DIV1) break; div1.push({ uid: p.uid, name: p.name }); }
    }
  }
  await wkRef.set({ week: wkNow, div1, moves, created: FV.serverTimestamp() });
  console.log(`Week ${wkNow} divisions: ${div1.map(p => p.name).join(', ')}${moves ? ` (up: ${moves.promoted.name}, down: ${moves.relegated.name})` : ''}.`);
}

// ---- 3. 6pm round-up: challenges waiting for you ----
const today = `${lp.y}-${String(lp.m).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`;
if (lp.h >= 18 && lp.h < 20 && meta.lastDigest !== today) {
  const open = (await db.collection('challenges').where('open', '==', true).get()).docs
    .map(d => ({ id: d.id, ...d.data() })).filter(c => c.expires > now);
  const tried = new Set((await db.collection('attempts').get()).docs.map(d => `${d.data().ch}_${d.data().uid}`));
  for (const d of (await players()).filter(d => d.daily !== false)) {
    const waiting = open.filter(c => c.setter !== d.uid && !tried.has(`${c.id}_${d.uid}`)).length;
    if (!waiting) continue;
    await send(d, {
      title: `${waiting} challenge${waiting > 1 ? 's' : ''} waiting for you ⚔️`,
      body: 'Crack a code within the target to win the stake. Up to 5 a day.',
      tag: 'digest', ttl: 5 * 3600,
    });
  }
  update.lastDigest = today;
  console.log('Round-up done.');
}

if (Object.keys(update).length) await metaRef.set(update, { merge: true });
console.log(`Finished. ${sent} notification(s) delivered.`);
