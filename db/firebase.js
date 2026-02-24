import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load service account key
const serviceAccount = JSON.parse(
    readFileSync(join(__dirname, '..', 'cert', 'serviceAccountKey.json'), 'utf8')
);

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// Firestore database instance
const db = admin.firestore();

// Firebase Auth instance
const auth = admin.auth();

// Convenient references
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

export { db, auth, FieldValue, Timestamp, admin };
