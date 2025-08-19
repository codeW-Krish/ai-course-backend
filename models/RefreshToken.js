import { pool } from "../db/db.js";

export default class RefreshTokenModel {
  static async create({ userId, token, expiresAt,ipAddress = null }) {
    const q = `
      INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address)
      VALUES ($1, $2, $3, $4)
      RETURNING id, token, expires_at, created_at
    `;
    const { rows } = await pool.query(q, [userId, token, expiresAt, ipAddress]);
    return rows[0];
  }

  static async findByToken(token) {
    const { rows } = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 LIMIT 1',
      [token]
    );
    return rows[0] || null;
  }

  static async revoke(token) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
    return true;
  }

  static async revokeByUserId(userId) {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
    return true;
  }
}
