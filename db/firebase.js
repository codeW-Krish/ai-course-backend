import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load service account key:
// 1) From FIREBASE_SERVICE_ACCOUNT env var (for cloud deployment like Render)
// 2) Fallback to local cert/serviceAccountKey.json file (for local dev)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase: loaded service account from environment variable');
} else {
    const certPath = join(__dirname, '..', 'cert', 'serviceAccountKey.json');
    if (existsSync(certPath)) {
        serviceAccount = JSON.parse(readFileSync(certPath, 'utf8'));
        console.log('✅ Firebase: loaded service account from cert/ file');
    } else {
        throw new Error(
            'No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT env var or provide cert/serviceAccountKey.json'
        );
    }
}

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
