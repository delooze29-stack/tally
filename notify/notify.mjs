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
        title: morning ? 'Morning code is ready 🔢' : 'Evening code is ready 🔢',
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

// ---- 3. 6pm round-up: challenges waiting for you ----
const today = `${lp.y}-${String(lp.m).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`;
if (lp.h === 18 && meta.lastDigest !== today) {
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
