// Sets a new password for a player, by nickname. Run from GitHub: Actions → "Reset a password".
// The new password never appears in the logs. Tell the player, and they can change it in the game.
import admin from 'firebase-admin';
const name = (process.env.NICKNAME || '').trim(), pw = process.env.NEW_PASSWORD || '';
if (!name) { console.log('::error::Type the player\'s nickname.'); process.exit(1); }
if (pw.length < 6) { console.log('::error::The new password needs at least 6 characters.'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
const doc = await admin.firestore().collection('names').doc(slug).get();
if (!doc.exists) { console.log(`::error::No player called "${name}". Check the spelling.`); process.exit(1); }
const uid = doc.data().uid;
const p = await admin.firestore().collection('players').doc(uid).get();
await admin.auth().updateUser(uid, { password: pw });
console.log(`::notice::Done. ${p.exists ? p.data().name : name} can now sign in with the new password.`);
