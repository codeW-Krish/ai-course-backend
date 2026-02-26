import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRouter from "./routes/auth.js";
import courseRouter from "./routes/course.js";
import adminRouter from "./routes/admin.js";
import settingsRouter from "./routes/settings.js";
import interactiveRouter from "./routes/interactive.js";
import flashcardRouter from "./routes/flashcard.js";
import notesRouter from "./routes/notes.js";
import audioRouter from "./routes/audio.js";
import gamificationRouter from "./routes/gamification.js";
import analyticsRouter from "./routes/analytics.js";
import userRouter from "./routes/user.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());

app.use((req, res, next) => {
    if (req.originalUrl.includes('/generate-content-stream')) {
        next(); // Skip JSON parsing for SSE endpoints
    } else {
        express.json()(req, res, next);
    }
});

app.use("/api/auth", authRouter);
app.use("/api/courses", courseRouter);
app.use("/api/admin", adminRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/interactive", interactiveRouter);
app.use("/api/flashcards", flashcardRouter);
app.use("/api/notes", notesRouter);
app.use("/api/audio", audioRouter);
app.use("/api/gamification", gamificationRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/users", userRouter);

app.get("/", (req, res) => {
    res.send("Hello, Index Page and Ngrok is working");
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on PORT ${PORT} http://0.0.0.0:${PORT}/`);
});
