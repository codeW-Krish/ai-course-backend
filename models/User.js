import { db, auth } from "../db/firebase.js";

const usersRef = db.collection("users");

const User = {
    /**
     * Create a new user in Firebase Auth + Firestore
     */
    create: async ({ email, password, username }) => {
        // Create user in Firebase Auth
        const firebaseUser = await auth.createUser({
            email,
            password,
            displayName: username,
        });

        // Create user doc in Firestore
        const userData = {
            email,
            username,
            role: "user",
            profile_image_url: null,
            created_at: new Date(),
        };

        await usersRef.doc(firebaseUser.uid).set(userData);

        return { id: firebaseUser.uid, ...userData };
    },

    /**
     * Find user by email
     */
    findByEmail: async (email) => {
        const snapshot = await usersRef.where("email", "==", email).limit(1).get();
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        return { id: doc.id, ...doc.data() };
    },

    /**
     * Find user by Firestore doc ID (uid)
     */
    findById: async (id) => {
        const doc = await usersRef.doc(id).get();
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() };
    },

    /**
     * Get user role
     */
    getRole: async (id) => {
        const doc = await usersRef.doc(id).get();
        if (!doc.exists) return null;
        return doc.data().role || "user";
    },

    /**
     * Update user profile
     */
    update: async (id, updates) => {
        await usersRef.doc(id).update(updates);
        const doc = await usersRef.doc(id).get();
        return { id: doc.id, ...doc.data() };
    },
};

export default User;