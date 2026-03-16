import { db } from "../db/firebase.js";

const settingsRef = db.collection("global_settings");

const GlobalSettings = {
    /**
     * Get all settings as key-value pairs
     */
    getAll: async () => {
        const snapshot = await settingsRef.get();
        const settings = {};
        snapshot.docs.forEach((doc) => {
            settings[doc.id] = doc.data().value;
        });
        return settings;
    },

    /**
     * Get a single setting by key
     */
    getByKey: async (key) => {
        const doc = await settingsRef.doc(key).get();
        if (!doc.exists) return null;
        return doc.data().value;
    },

    /**
     * Update a setting (create or overwrite)
     */
    update: async (key, value) => {
        await settingsRef.doc(key).set({ value }, { merge: true });
        return { key, value };
    },

    /**
     * Get default LLM provider
     */
    getDefaultProvider: async () => {
        const doc = await settingsRef.doc("default_provider").get();
        if (!doc.exists) return { provider: "Gemini", model: null };
        return doc.data().value;
    },

    /**
     * Get default providers (outline + content) — called by settings routes
     */
    getDefaultProviders: async () => {
        const [outlineDoc, contentDoc] = await Promise.all([
            settingsRef.doc("default_outline_provider").get(),
            settingsRef.doc("default_content_provider").get(),
        ]);
        return {
            outlineProvider: outlineDoc.exists ? outlineDoc.data().value : "Gemini",
            contentProvider: contentDoc.exists ? contentDoc.data().value : "Gemini",
        };
    },

    /**
     * Get available LLM providers list
     */
    getAvailableProviders: async () => {
        const doc = await settingsRef.doc("available_providers").get();
        if (!doc.exists) {
            return ["Gemini", "Groq", "Cerebras", "GLM"];
        }
        return doc.data().value;
    },
};

export default GlobalSettings;