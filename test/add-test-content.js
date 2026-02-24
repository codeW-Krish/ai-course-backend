// Quick helper: find first subtopic with content, or generate content for one
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const sa = JSON.parse(readFileSync(join(__dirname, '..', 'cert', 'serviceAccountKey.json'), 'utf8'));
const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, 'helper-' + Date.now());
const db = app.firestore();

const COURSE_ID = 'yjalHyRSPnxxsUiVJDkR';

const unitsSnap = await db.collection('courses').doc(COURSE_ID)
    .collection('units').orderBy('position').limit(1).get();

if (unitsSnap.empty) {
    console.log('No units found');
    process.exit(1);
}

const unitDoc = unitsSnap.docs[0];
console.log('Unit:', unitDoc.id, '-', unitDoc.data().title);

const subsSnap = await unitDoc.ref.collection('subtopics').orderBy('position').limit(1).get();
const subDoc = subsSnap.docs[0];
console.log('Subtopic:', subDoc.id, '-', subDoc.data().title);
console.log('Has content:', !!subDoc.data().content);

// If no content, add mock content so tests can run
if (!subDoc.data().content) {
    console.log('\nAdding test content to subtopic...');
    const mockContent = {
        subtopic_title: subDoc.data().title,
        title: subDoc.data().title,
        why_this_matters: "Understanding this concept is fundamental to the course.",
        core_concepts: [
            { concept: "Key Idea 1", explanation: "Firebase is a backend-as-a-service platform by Google." },
            { concept: "Key Idea 2", explanation: "Firestore is a NoSQL document database in Firebase." }
        ],
        examples: [
            { type: "analogy", content: "Think of Firestore like a filing cabinet with labeled folders." },
            { type: "technical_example", content: "const doc = await db.collection('users').doc(userId).get();" }
        ],
        code_or_math: "// Initialize Firebase\nimport admin from 'firebase-admin';\nconst db = admin.firestore();",
        youtube_keywords: null
    };

    await subDoc.ref.update({
        content: mockContent,
        content_generated_at: new Date(),
    });

    console.log('✅ Content added to:', subDoc.id);
}

await app.delete();
console.log('\nDone. Subtopic ID for testing:', subDoc.id);
