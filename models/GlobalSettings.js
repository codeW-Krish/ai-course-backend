import { pool } from "../db/db.js";

export default class GlobalSettings {
    // Get all global settings
    static async getAll() {
        const { rows } = await pool.query(`
            SELECT key, value, description, updated_at 
            FROM global_settings 
            ORDER BY key
        `);
        return rows;
    }

    // Get specific setting by key
    static async getByKey(key) {
        const { rows } = await pool.query(
            'SELECT value FROM global_settings WHERE key = $1',
            [key]
        );
        return rows[0]?.value || null;
    }

    // Update setting (admin only)
    static async update(key, value, userId) {
        const { rows } = await pool.query(`
            UPDATE global_settings 
            SET value = $1, updated_by = $2, updated_at = NOW() 
            WHERE key = $3 
            RETURNING key, value, description, updated_at
        `, [value, userId, key]);
        return rows[0];
    }

    // Get available providers list
    static async getAvailableProviders() {
        const value = await this.getByKey('available_providers');
        try {
            return JSON.parse(value) || [];
        } catch {
            return ['Groq', 'Gemini', 'Cerebras']; // fallback
        }
    }

    // Get default providers
    static async getDefaultProviders() {
        const [outline, content] = await Promise.all([
            this.getByKey('default_outline_provider'),
            this.getByKey('default_content_provider')
        ]);
        
        return {
            outline: outline || 'Groq',
            content: content || 'Groq'
        };
    }
}