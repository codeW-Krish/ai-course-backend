import { pool } from "../db/db.js";

export default class User{
    static async create({email, passwordHash, username, pfp_url=null}){
        const query = `
            INSERT INTO users(email, password_has, username, profile_image,url) VALUES 
            ($1, $2, $3, $4)
            RETURNING id, email, username, created_at
        `;
        const {rows} = await pool.query(query, [email, passwordHash, username, pfp_url]);
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
}