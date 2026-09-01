import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
    path: path.resolve(__dirname, "../.env")
});

const app = express();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "studenthub_secret";

app.use(cors());

app.use(express.json({
    limit: "10mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "10mb"
}));

app.use(
    express.static(
        path.join(__dirname, "../frontend")
    )
);

mongoose.connect(
    process.env.MONGO_URI ||
    "mongodb://127.0.0.1:27017/studenthub"
)
.then(() => {
    console.log("✅ MongoDB Connected");
})
.catch((err) => {
    console.log("❌ Mongo Error:", err.message);
});

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    }
});

const User = mongoose.model("User", userSchema);

const chatSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    messages: Array,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Chat = mongoose.model("Chat", chatSchema);

function auth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                error: "No token provided"
            });
        }

        const token = authHeader.split(" ")[1];

        req.user = jwt.verify(
            token,
            JWT_SECRET
        );

        next();

    } catch (err) {
        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }
}

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

// Initialize Google Gen AI client using GEMINI_API_KEY
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const userChats = {};
const MAX_HISTORY = 15;

app.post("/api/register", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: "Username and password required"
            });
        }

        const existingUser = await User.findOne({ username });

        if (existingUser) {
            return res.status(400).json({
                error: "User already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await User.create({
            username,
            password: hashedPassword
        });

        res.json({
            message: "Registration successful"
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({
            error: "Registration failed"
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({ username });

        if (!user) {
            return res.status(400).json({
                error: "Invalid credentials"
            });
        }

        const validPassword = await bcrypt.compare(
            password,
            user.password
        );

        if (!validPassword) {
            return res.status(400).json({
                error: "Invalid credentials"
            });
        }

        const token = jwt.sign(
            { id: user._id },
            JWT_SECRET,
            { expiresIn: "24h" }
        );

        res.json({
            token,
            username: user.username
        });

    } catch (err) {
        res.status(500).json({
            error: "Login failed"
        });
    }
});

app.post(
    "/api/chat",
    auth,
    upload.array("files", 5),
    async (req, res) => {
        const uploadedFiles = req.files || [];

        try {
            const { message, isSummarize } = req.body;
            const userId = req.user.id;

            if (!message && uploadedFiles.length === 0) {
                return res.status(400).json({
                    error: "Message or files required"
                });
            }

            let fileContext = "";

            for (const file of uploadedFiles) {
                if (
                    file.mimetype.includes("text") ||
                    file.mimetype.includes("json") ||
                    file.mimetype.includes("javascript") ||
                    file.mimetype.includes("html") ||
                    file.mimetype.includes("css")
                ) {
                    const data = fs.readFileSync(file.path, "utf-8");
                    fileContext += `\n[File: ${file.originalname}]\n${data}\n`;
                } else if (file.mimetype.startsWith("image/")) {
                    fileContext += `\n[User uploaded image: ${file.originalname}]\n`;
                } else {
                    fileContext += `\n[Uploaded File: ${file.originalname}]\n`;
                }
            }

            let finalPrompt = message || "";

            if (isSummarize === "true") {
                finalPrompt = `Summarize this clearly:\n\n${message}`;
            }

            finalPrompt += fileContext ? `\n\nUploaded Content:\n${fileContext}` : "";

            const systemInstruction = `
You are Student Hub AI.
1. Default language is English.
2. If user speaks Telugu or Tenglish, reply in Telugu/Tenglish.
3. Help students clearly.
4. Summarize when requested.
5. Analyze uploaded files.
6. Keep answers clean and readable.
`;

            // Call Gemini API stream first to catch any API/key errors before writing headers
            const responseStream = await ai.models.generateContentStream({
                model: "gemini-2.5-flash",
                contents: finalPrompt,
                config: {
                    systemInstruction: systemInstruction
                }
            });

            // Now safely write headers since the stream connection is established
            res.writeHead(200, {
                "Content-Type": "text/plain; charset=utf-8",
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });

            let fullReply = "";

            for await (const chunk of responseStream) {
                const content = chunk.text || "";
                if (content) {
                    fullReply += content;
                    res.write(content);
                }
            }

            res.end();

            await Chat.create({
                userId,
                messages: [
                    { role: "user", content: message },
                    { role: "assistant", content: fullReply }
                ]
            });

            for (const f of uploadedFiles) {
                if (fs.existsSync(f.path)) {
                    fs.unlinkSync(f.path);
                }
            }

        } catch (err) {
            console.log("❌ Chat Error:", err);

            for (const f of uploadedFiles) {
                if (fs.existsSync(f.path)) {
                    fs.unlinkSync(f.path);
                }
            }

            if (!res.headersSent) {
                res.status(500).json({
                    error: err.message || "AI service error"
                });
            } else {
                res.end();
            }
        }
    }
);
app.get(
    "/api/history",
    auth,
    async (req, res) => {
        try {
            const chats = await Chat.find({ userId: req.user.id })
                .sort({ createdAt: -1 })
                .limit(20);

            res.json(chats);
        } catch (err) {
            res.status(500).json({
                error: "Failed to fetch history"
            });
        }
    }
);

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "../frontend/login.html")
    );
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
