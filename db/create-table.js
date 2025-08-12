import e from "express";
import {pool} from "./db.js"

const createTableSQL = `

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- USER TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    email VARCHAR UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username VARCHAR NOT NULL UNIQUE,
    profile_image_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- COURSES TABLE
CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    difficulty TEXT CHECK (difficulty IN ('Beginner', 'Intermediate', 'Advanced')),
    include_videos BOOLEAN DEFAULT FALSE,
    status TEXT CHECK (status IN ('draft', 'generating', 'ready')),
    outline_json JSONB,
    outline_generated_at TIMESTAMP,
    content_generated_at TIMESTAMP,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- UNITS TABLE
CREATE TABLE IF NOT EXISTS units (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INT NOT NULL
);

-- SUBTOPICS TABLE
CREATE TABLE IF NOT EXISTS subtopics (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT,
    position INT NOT NULL
);

-- VIDEOS TABLE
CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    subtopic_id UUID NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    youtube_url TEXT UNIQUE NOT NULL,
    thumbnail TEXT UNIQUE NOT NULL,
    duration_sec INT
);

-- USER_COURSES TABLE
CREATE TABLE IF NOT EXISTS user_courses (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, course_id)
);

-- USER_PROGRESS TABLE
CREATE TABLE IF NOT EXISTS user_progress (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    subtopic_id UUID NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE,
    completed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, subtopic_id)
);

-- USER_NOTES TABLE
CREATE TABLE IF NOT EXISTS user_notes (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subtopic_id UUID NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- COURSE_REVIEWS TABLE
CREATE TABLE IF NOT EXISTS course_reviews (
    id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    rating INT CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, course_id)
);

-- COURSE_PUBLIC_STATS TABLE
CREATE TABLE IF NOT EXISTS course_public_stats (
    course_id UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    total_users_joined INT DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);

`;

const createTables = async () => {
    const client = await pool.connect()
    try {
        await client.query(createTableSQL)
        console.log("Tables created successfully");        
    } catch (error) {
        console.log("Error while creating tables", error);
    } finally {
        client.release();
        await pool.end();
    }
}

createTables()