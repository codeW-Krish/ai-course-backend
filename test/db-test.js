/**
 * Firestore Connection Diagnostic
 * Tests multiple connection methods to find the issue.
 * 
 * Usage: node test/db-test.js
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔥 Firestore Connection Diagnostic');
console.log('═══════════════════════════════════\n');

// Load service account
const serviceAccount = JSON.parse(
    readFileSync(join(__dirname, '..', 'cert', 'serviceAccountKey.json'), 'utf8')
);
console.log(`📋 Service Account Details:`);
console.log(`   Project ID:    ${serviceAccount.project_id}`);
console.log(`   Client Email:  ${serviceAccount.client_email}`);
console.log(`   Key ID:        ${serviceAccount.private_key_id}`);

// ─── TEST 1: Default gRPC mode ───
console.log('\n─── TEST 1: Default mode (gRPC) ───');
try {
    const app1 = admin.initializeApp(
        { credential: admin.credential.cert(serviceAccount) },
        'test-grpc-' + Date.now()
    );
    const db1 = app1.firestore();

    // Print internal project info
    console.log(`   Firestore project: ${db1._settings?.projectId || 'unknown'}`);
    console.log(`   Database ID: (default)`);

    console.log('   Writing test doc...');
    await db1.collection('_test').doc('ping').set({ ts: new Date() });
    console.log('   ✅ gRPC mode WORKS!');
    await db1.collection('_test').doc('ping').delete();
    await app1.delete();
} catch (err) {
    console.log(`   ❌ gRPC FAILED: code=${err.code} — ${err.details || err.message}`);
    console.log(`   (This often means project ID mismatch or Firestore not provisioned for this project)`);
}

// ─── TEST 2: REST mode (preferRest) ───
console.log('\n─── TEST 2: REST mode (preferRest: true) ───');
try {
    const app2 = admin.initializeApp(
        { credential: admin.credential.cert(serviceAccount) },
        'test-rest-' + Date.now()
    );
    const db2 = app2.firestore();
    db2.settings({ preferRest: true });

    console.log('   Writing test doc...');
    await db2.collection('_test').doc('ping').set({ ts: new Date() });
    console.log('   ✅ REST mode WORKS!');
    await db2.collection('_test').doc('ping').delete();
    await app2.delete();
} catch (err) {
    console.log(`   ❌ REST FAILED: ${err.code} — ${err.message}`);
}

// ─── TEST 3: Direct REST API call ───
console.log('\n─── TEST 3: Direct Firestore REST API ───');
try {
    // Get an access token using the service account
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/datastore'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const projectId = serviceAccount.project_id;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/_test/rest_ping`;

    console.log(`   URL: ${url}`);
    console.log(`   Token: ${token.token ? '✅ Got access token' : '❌ No token'}`);

    // Write
    const writeRes = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fields: {
                message: { stringValue: 'REST API test' },
                timestamp: { stringValue: new Date().toISOString() },
            },
        }),
    });

    const writeData = await writeRes.json();
    console.log(`   Response status: ${writeRes.status}`);

    if (writeRes.ok) {
        console.log('   ✅ REST API WORKS!');
        console.log(`   Document: ${JSON.stringify(writeData).substring(0, 200)}`);

        // Cleanup
        await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token.token}` },
        });
    } else {
        console.log(`   ❌ REST API FAILED:`);
        console.log(`   ${JSON.stringify(writeData, null, 2)}`);

        if (writeData.error?.status === 'NOT_FOUND') {
            console.log('\n   ⚠️  DATABASE NOT FOUND for this project ID!');
            console.log(`   ⚠️  Your service account is for project: ${projectId}`);
            console.log('   ⚠️  But Firestore may be in a DIFFERENT project.');
            console.log('   ➡️  Go to Firebase Console → Project Settings → check Project ID');
        }
    }
} catch (err) {
    console.log(`   ❌ REST API error: ${err.message}`);
}

console.log('\n═══════════════════════════════════');
console.log('Done.\n');
process.exit(0);
