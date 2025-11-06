import { pool } from "../db/db.js";

export default class User {
    static async create({email, passwordHash, username, role='user'}){
        const query = `
            INSERT INTO users(email, password_hash, username, role) VALUES 
            ($1, $2, $3, $4)
            RETURNING id, email, username, role, created_at
        `;
        const {rows} = await pool.query(query, [email, passwordHash, username, role]);
        return rows[0];
    }

    static async findByEmail(email) {
        const {rows} = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        return rows[0] || null;
    }

    static async findById(id){
        const {rows} = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
        return rows[0] || null;
    }

    // Add method to get user by ID with role
    static async getUserWithRole(id) {
        const {rows} = await pool.query(
            "SELECT id, email, username, role, created_at FROM users WHERE id = $1", 
            [id]
        );
        return rows[0] || null;
    }
}