import fs from 'fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, writeBatch, runTransaction, serverTimestamp, increment, arrayUnion, arrayRemove } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-tally', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
const DAY = Math.floor((Date.now() - 1792713600000) / 864e5) + 1;
const exp = () => Date.now() + 7 * 864e5;
const out = []; let fails = 0;
async function t(name, fn, ok) {
  try { ok ? await assertSucceeds(fn()) : await assertFails(fn()); out.push(`PASS ${name}`); }
  catch (e) { fails++; out.push(`FAIL ${name} :: ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 600)}`); }
}
await env.withSecurityRulesDisabled(async ctx => {
  const d = ctx.firestore();
  for (const [u, n] of [['A', 'Ann'], ['B', 'Bob'], ['C', 'Cat'], ['D', 'Dan'], ['E', 'Eve']])
    await setDoc(doc(d, 'players', u), { name: n, total: 50, played: 5, wins: 5, last: 0 });
  const ch = (id, drop = []) => { const o = { setter: 'A', setterName: 'Ann', c: 't112345', cs: 1, target: 4, stake: 5, created: new Date(), expires: exp(), open: true, paused: false, round: 1, clue: true, tries: 0, cracks: 0 }; drop.forEach(k => delete o[k]); return setDoc(doc(d, 'challenges', id), o); };
  await ch('ch1'); await ch('ch2', ['paused', 'round', 'clue']); await ch('ch3');
});
const db = u => env.authenticatedContext(u).firestore();
const accept = (u, name, cid, round = 1, stake = 5, target = 4) => () => {
  const d = db(u), b = writeBatch(d);
  b.set(doc(d, 'attempts', `${cid}_${u}`), { ch: cid, uid: u, name, setter: 'A', sname: 'Ann', stake, target, round, day: DAY, g: [], status: 'playing', won: false, ts: serverTimestamp() });
  b.update(doc(d, 'challenges', cid), { tries: increment(1) });
  return env.withSecurityRulesDisabled(async c => { const s = await getDoc(doc(c.firestore(), 'limits', `${u}_${DAY}`)); return s.exists() ? s.data().n : 0; })
    .then(n => { b.set(doc(d, 'limits', `${u}_${DAY}`), { uid: u, day: DAY, n: n + 1 }); return b.commit(); });
};
const finish = (u, cid, { won, late, pay, pause }) => () => {
  const d = db(u);
  return runTransaction(d, async tx => {
    await tx.get(doc(d, 'challenges', cid));
    const data = { g: ['11111', '22222'], status: 'done', won, secs: 30, ts: serverTimestamp() };
    if (late !== undefined) data.late = late; if (pay !== undefined) data.pay = pay;
    tx.update(doc(d, 'attempts', `${cid}_${u}`), data);
    if (won) tx.update(doc(d, 'challenges', cid), pause ? { cracks: increment(1), open: false, paused: true } : { cracks: increment(1) });
  });
};

// ---- challenge: create
await t('new-style challenge create', () => setDoc(doc(db('A'), 'challenges', 'n1'), { setter: 'A', setterName: 'Ann', c: 't112345', cs: 1, target: 4, stake: 5, created: serverTimestamp(), expires: exp(), open: true, paused: false, round: 1, clue: true, tries: 0, cracks: 0 }), true);
await t('old-style challenge create still works', () => setDoc(doc(db('A'), 'challenges', 'n2'), { setter: 'A', setterName: 'Ann', c: 't112345', cs: 1, target: 4, stake: 5, created: serverTimestamp(), expires: exp(), open: true, tries: 0, cracks: 0 }), true);
await t('cannot create already-paused challenge', () => setDoc(doc(db('A'), 'challenges', 'n3'), { setter: 'A', setterName: 'Ann', c: 't112345', cs: 1, target: 4, stake: 5, created: serverTimestamp(), expires: exp(), open: true, paused: true, round: 1, clue: true, tries: 0, cracks: 0 }), false);
// ---- challenge: accept, crack, late
await t('B accepts ch1', accept('B', 'Bob', 'ch1'), true);
await t('C accepts ch1', accept('C', 'Cat', 'ch1'), true);
await t('E accepts ch1', accept('E', 'Eve', 'ch1'), true);
await t('B cannot claim late while it is open', finish('B', 'ch1', { won: true, late: true, pay: true, pause: false }), false);
await t('B cracks first and pauses it', finish('B', 'ch1', { won: true, late: false, pay: true, pause: true }), true);
await t('C cannot claim not-late once paused', finish('C', 'ch1', { won: true, late: false, pay: true, pause: false }), false);
await t('C cannot pause it again', finish('C', 'ch1', { won: true, late: false, pay: true, pause: true }), false);
await t('C cracks it late (setter can pay)', finish('C', 'ch1', { won: true, late: true, pay: true, pause: false }), true);
await t('E fails late', finish('E', 'ch1', { won: false, late: true }), true);
await t('D cannot accept a paused challenge', accept('D', 'Dan', 'ch1'), false);
// ---- re-open / close
await t('B cannot re-open someone else\'s challenge', () => updateDoc(doc(db('B'), 'challenges', 'ch1'), { open: true, paused: false, round: 2, stake: 3, target: 5, clue: false, expires: exp() }), false);
await t('A cannot re-open with stake 20', () => updateDoc(doc(db('A'), 'challenges', 'ch1'), { open: true, paused: false, round: 2, stake: 20, target: 5, clue: false, expires: exp() }), false);
await t('A re-opens ch1 (round 2, 3 pts, 5 guesses, no clue)', () => updateDoc(doc(db('A'), 'challenges', 'ch1'), { open: true, paused: false, round: 2, stake: 3, target: 5, clue: false, expires: exp() }), true);
await t('A cannot re-open an already open challenge', () => updateDoc(doc(db('A'), 'challenges', 'ch1'), { open: true, paused: false, round: 3, stake: 3, target: 5, clue: false, expires: exp() }), false);
await t('B cannot play it again after re-open', accept('B', 'Bob', 'ch1', 2, 3, 5), false);
await t('D cannot join with old round number', accept('D', 'Dan', 'ch1', 1, 3, 5), false);
await t('D accepts round 2', accept('D', 'Dan', 'ch1', 2, 3, 5), true);
await t('D cracks round 2 first and pauses it', finish('D', 'ch1', { won: true, late: false, pay: true, pause: true }), true);
await t('A closes paused ch1', () => updateDoc(doc(db('A'), 'challenges', 'ch1'), { open: false, paused: false }), true);
await t('B cannot close someone else\'s', () => updateDoc(doc(db('B'), 'challenges', 'ch3'), { open: false, paused: false }), false);
// ---- old-style challenge flow still works (for the minutes before the new game goes live)
await t('old-style accept (no round)', () => { const d = db('B'), b = writeBatch(d);
  b.set(doc(d, 'attempts', 'ch2_B'), { ch: 'ch2', uid: 'B', name: 'Bob', setter: 'A', sname: 'Ann', stake: 5, target: 4, day: DAY, g: [], status: 'playing', won: false, ts: serverTimestamp() });
  b.update(doc(d, 'challenges', 'ch2'), { tries: increment(1) }); b.set(doc(d, 'limits', `B_${DAY}`), { uid: 'B', day: DAY, n: 2 }); return b.commit(); }, true);
await t('old-style crack (no late/pay, cracks only)', finish('B', 'ch2', { won: true, pause: false }), true);
await t('old-style close (open only)', () => updateDoc(doc(db('A'), 'challenges', 'ch3'), { open: false }), true);
// ---- leagues
const mkLeague = (withMember) => () => { const d = db('A'), b = writeBatch(d);
  b.set(doc(d, 'leagues', withMember ? 'L1' : 'L0'), { name: 'Depot Lot', owner: 'A', ownerName: 'Ann', members: ['A'], created: serverTimestamp() });
  if (withMember) b.set(doc(d, 'members', 'L1_A'), { league: 'L1', uid: 'A', name: 'Ann', joined: serverTimestamp() });
  return b.commit(); };
await t('league needs its member record', mkLeague(false), false);
await t('A creates league', mkLeague(true), true);
const invite = (from, fromName, to, toName, lid = 'L1') => () => setDoc(doc(db(from), 'invites', `${lid}_${to}`), { league: lid, leagueName: 'Depot Lot', uid: to, name: toName, from: fromName, ts: serverTimestamp() });
await t('A invites B', invite('A', 'Ann', 'B', 'Bob'), true);
await t('B cannot invite to A\'s league', invite('B', 'Bob', 'C', 'Cat'), false);
await t('A cannot invite a member', invite('A', 'Ann', 'A', 'Ann'), false);
const join = (u, n, lid = 'L1') => () => { const d = db(u), b = writeBatch(d);
  b.update(doc(d, 'leagues', lid), { members: arrayUnion(u) });
  b.set(doc(d, 'members', `${lid}_${u}`), { league: lid, uid: u, name: n, joined: serverTimestamp() });
  b.delete(doc(d, 'invites', `${lid}_${u}`)); return b.commit(); };
await t('C cannot join without an invite', join('C', 'Cat'), false);
await t('B joins with invite', join('B', 'Bob'), true);
await t('A invites C', invite('A', 'Ann', 'C', 'Cat'), true);
await t('C declines (deletes invite)', () => deleteDoc(doc(db('C'), 'invites', 'L1_C')), true);
await t('A invites C again', invite('A', 'Ann', 'C', 'Cat'), true);
await t('C joins', join('C', 'Cat'), true);
await t('B can read league', () => getDoc(doc(db('B'), 'leagues', 'L1')), true);
await t('signed-out cannot read league', () => getDoc(doc(env.unauthenticatedContext().firestore(), 'leagues', 'L1')), false);
await t('D (not member) cannot remove B', () => { const d = db('D'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('B') }); return b.commit(); }, false);
await t('B cannot remove C', () => { const d = db('B'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('C') }); b.delete(doc(d, 'members', 'L1_C')); return b.commit(); }, false);
await t('B cannot remove the owner', () => { const d = db('B'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('A') }); return b.commit(); }, false);
await t('A removes C', () => { const d = db('A'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('C') }); b.delete(doc(d, 'members', 'L1_C')); return b.commit(); }, true);
await t('B leaves', () => { const d = db('B'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('B') }); b.delete(doc(d, 'members', 'L1_B')); return b.commit(); }, true);
await t('owner cannot leave own league', () => { const d = db('A'), b = writeBatch(d); b.update(doc(d, 'leagues', 'L1'), { members: arrayRemove('A') }); b.delete(doc(d, 'members', 'L1_A')); return b.commit(); }, false);
await t('A cannot rename league', () => updateDoc(doc(db('A'), 'leagues', 'L1'), { name: 'X' }), false);
await t('A invites D (for delete test)', invite('A', 'Ann', 'D', 'Dan'), true);
await t('B cannot delete league', () => deleteDoc(doc(db('B'), 'leagues', 'L1')), false);
await t('A deletes league with its records', () => { const d = db('A'), b = writeBatch(d); b.delete(doc(d, 'members', 'L1_A')); b.delete(doc(d, 'invites', 'L1_D')); b.delete(doc(d, 'leagues', 'L1')); return b.commit(); }, true);

await env.cleanup();
const txt = `${fails ? 'FAILED' : 'ALL PASSED'} (${out.length - fails}/${out.length})\n` + out.join('\n') + '\n';
fs.writeFileSync('results.txt', txt); console.log(txt);
process.exit(0);
