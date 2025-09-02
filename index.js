import express from "express";
import {pool} from "./db/db.js"
import dotenv from "dotenv"
import authRouter from "./routes/auth.js";
import courseRouter from "./routes/course.js";

dotenv.config()


// const test = async () => {
//     try {
//         const res = await pool.query('SELECT NOW()');
//         console.log("Connceted", res.rows[0]);
// //         const res1 = await pool.query(`CREATE TABLE IF NOT EXISTS refresh_tokens (
// //   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
// //   user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
// //   token TEXT NOT NULL UNIQUE,
// //   ip_address TEXT,           
// //   expires_at TIMESTAMP NOT NULL,
// //   created_at TIMESTAMP DEFAULT NOW()
// // );
// // CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);`)
//         // const res2 = await pool.query(`SELECT tablename
//         //                                 FROM pg_catalog.pg_tables
//         //                                 WHERE schemaname = 'public';`);
//         // console.log("Tables in Schema");
//         // res2.rows.forEach(row => console.log(row.tablename));
        
//         const res3 = await pool.query(`
//             SELECT 
//     table_name,
//     column_name,
//     data_type,
//     is_nullable,
//     character_maximum_length,
//     column_default
// FROM information_schema.columns
// WHERE table_schema = 'public'
// ORDER BY table_name, ordinal_position;
// `);
//             console.log("Table Schema Description:");
// res3.rows.forEach(row => {
//     console.log(
//         `${row.table_name} | ${row.column_name} | ${row.data_type} | Nullable: ${row.is_nullable} | Max Length: ${row.character_maximum_length} | Default: ${row.column_default}`
//     );
// });

        
//     } catch (error) {
//         console.log("DB Connection failed", error);
//     }finally {
//         await pool.end();
//     }
// }

// test();

// const createCourseGenerationStatusTable = async () => {
//     try {
//         const res = await pool.query(`
//             CREATE TABLE IF NOT EXISTS course_generation_status (
//                 course_id UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
//                 status VARCHAR(20) NOT NULL DEFAULT 'pending',
//                 total_subtopics INT DEFAULT 0,
//                 generated_subtopics INT DEFAULT 0,
//                 last_updated TIMESTAMP DEFAULT NOW()
//             );
//         `);
//         console.log("✅ Table 'course_generation_status' created or already exists.");
//     } catch (error) {
//         console.error("❌ Failed to create 'course_generation_status' table:", error);
//     } finally {
//         await pool.end(); // Optional: remove if keeping the app running
//     }
// };

// createCourseGenerationStatusTable();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use("/api/auth",authRouter);

app.use("/api/courses",courseRouter);

app.get("/",(req, res) => {
    res.send("Hello, Index Page and Ngrok is working");
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on PORT ${PORT} http://0.0.0.0:${PORT}/`);
});
