// One-off clean-up: removes the old-style once-a-day scores from 25 Oct 2026 (day 3),
// which were played just before Tally switched to two codes a day, and takes their
// points back off each player's All time total. Run from GitHub: Actions > Tally clean-up.
// Type "yes" in the box to make the changes; anything else just shows what would change.
import admin from 'firebase-admin';

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!SA) { console.log('No FIREBASE_SERVICE_ACCOUNT secret.'); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
const APPLY = (process.env.APPLY || '').trim().toLowerCase() === 'yes';
const DAY = 3;

const scores = (await db.collection('scores').where('day', '==', DAY).get()).docs;
console.log(APPLY ? 'MAKING CHANGES' : 'PREVIEW ONLY - nothing will change. Run again and type yes to apply.');
console.log(`Found ${scores.length} score(s) from the old daily code No. ${DAY}.`);

for (const s of scores) {
  const d = s.data();
  const pref = db.collection('players').doc(d.uid);
  await db.runTransaction(async tx => {
    const p = (await tx.get(pref)).data();
    if (!p) { console.log(`- ${d.name}: no player record, will just remove the score`); if (APPLY) tx.delete(s.ref); return; }
    const next = {
      total: Math.max(0, p.total - (d.points || 0)),
      played: Math.max(0, p.played - 1),
      wins: Math.max(0, p.wins - (d.won ? 1 : 0)),
    };
    console.log(`- ${d.name}: score ${d.guesses}/7, ${d.points} pts. Total ${p.total} -> ${next.total}, played ${p.played} -> ${next.played}, wins ${p.wins} -> ${next.wins}`);
    if (APPLY) { tx.update(pref, next); tx.delete(s.ref); }
  });
}
console.log(APPLY ? 'Done.' : 'Preview finished.');
