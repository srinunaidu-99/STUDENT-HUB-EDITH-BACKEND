import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Environment Variables
dotenv.config({
    path: path.resolve(__dirname, "../.env")
});

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "studenthub_secret";

// Global Middleware Config
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

// --- DATABASE CONNECTION ---
mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/studenthub"
)
.then(() => {
    console.log("✅ MongoDB Connected");
})
.catch((err) => {
    console.error("❌ Mongo Connection Error:", err.message);
});

// --- MONGOOSE SCHEMAS & MODELS ---
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

// --- REAL OTP EMAIL CONFIGURATION (NODEMAILER) ---
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
    }
});

const otpCache = {};

// --- SECURE AUTHENTICATION MIDDLEWARE ---
function auth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: "No token provided" });
        }

        const token = authHeader.split(" ")[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

// --- MULTI-PART FILE UPLOAD SYSTEM CONFIG ---
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
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- INTELLIGENCE CORE LAYER (GROQ ENGINE) ---
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const userChats = {};
const MAX_HISTORY = 15;

// --- USER ACCESSIBILITY ENDPOINTS ---
app.post("/api/register", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: "Username (Email) and password required" });
        }
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ error: "User profile already registered under this node" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        res.json({ message: "Registration successful" });
    } catch (err) {
        res.status(500).json({ error: "Registration sequence failure" });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ error: "Invalid identity credentials" });
        }
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: "Invalid identity credentials" });
        }
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, username: user.username });
    } catch (err) {
        res.status(500).json({ error: "Login orchestration fault" });
    }
});

// --- OTP PASSWORD RECOVERY ---
app.post("/api/forgot-password/request", async (req, res) => {
    try {
        const { contact } = req.body;
        if (!contact) return res.status(400).json({ error: "Target destination parameter missing." });
        const userExists = await User.findOne({ username: contact });
        if (!userExists) return res.status(404).json({ error: "No account profile mapping found for this email address." });

        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        otpCache[contact] = { otp: generatedOtp, expiresAt: Date.now() + 5 * 60 * 1000, verified: false };

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: contact,
            subject: "EDITH AI - Reset Security Credentials Token Verification",
            html: `<div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 30px; background-color: #0a0b17; color: #f3f4f6; border-radius: 16px; border: 1px solid #1e1b4b;">
                    <h2 style="color: #6366f1; text-align: center;">EDITH Identity Verification</h2>
                    <div style="font-size: 28px; font-weight: 700; background: #1e1b4b; padding: 16px; border-radius: 12px; text-align: center; color: #a5b4fc; margin: 25px 0;">${generatedOtp}</div>
                   </div>`
        };
        await transporter.sendMail(mailOptions);
        return res.json({ message: "Verification sequence dispatched." });
    } catch (err) {
        res.status(500).json({ error: "Failed to dispatch token." });
    }
});

app.post("/api/forgot-password/verify", async (req, res) => {
    try {
        const { contact, code } = req.body;
        const record = otpCache[contact];
        if (!record) return res.status(400).json({ error: "No recovery pipeline initiated." });
        if (Date.now() > record.expiresAt) {
            delete otpCache[contact];
            return res.status(400).json({ error: "Validation window expired." });
        }
        if (record.otp !== code.trim()) return res.status(400).json({ error: "Credential validation mismatch." });
        record.verified = true;
        return res.json({ message: "Identity state approved." });
    } catch (err) {
        res.status(500).json({ error: "Token authorization failure." });
    }
});

app.post("/api/forgot-password/reset", async (req, res) => {
    try {
        const { contact, password } = req.body;
        const record = otpCache[contact];
        if (!record || !record.verified) return res.status(403).json({ error: "Unauthorized access rejected." });
        const user = await User.findOne({ username: contact });
        if (!user) return res.status(404).json({ error: "User signature lost." });

        user.password = await bcrypt.hash(password, 10);
        await user.save();
        delete otpCache[contact];
        return res.json({ message: "Password updated successfully." });
    } catch (err) {
        res.status(500).json({ error: "System mutation update failure." });
    }
});

// --- FIXED ULTRA-LOW LATENCY CONVERSATIONAL MATRIX STREAMS ---
app.post("/api/chat", auth, upload.array("files", 5), async (req, res) => {
    const uploadedFiles = req.files || [];
    try {
        const { message, isSummarize, sessionId } = req.body;
        const userId = req.user.id;

        if (!message && uploadedFiles.length === 0) {
            return res.status(400).json({ error: "Empty request context arrays" });
        }

        // 1. CHAT DATABASE MANAGEMENT (CRUCIAL FIX FOR RE-OPENED SIDEBAR CHATS)
        let activeChatSessionId = sessionId;
        if (!activeChatSessionId || activeChatSessionId === "null") {
            const newChatRecord = await Chat.create({
                userId,
                messages: []
            });
            activeChatSessionId = newChatRecord._id.toString();
        }

        // Set Headers Immediately to Kill Buffer Compression Lag on Render / Nginx Network Layers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // THIS STOPS RENDER ENGINE BUFFER BLOCKING INSTANTLY!
        
        // Expose custom session IDs to modern browsers
        res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");
        res.setHeader("X-Session-Id", activeChatSessionId);
        res.flushHeaders(); 

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
                fileContext += `\n[File Contents Extraction: ${file.originalname}]\n${data}\n`;
            } else {
                fileContext += `\n[Meta Object Attachment Block: ${file.originalname}]\n`;
            }
        }

        // Memory State System Framework Initializer
        if (!userChats[userId]) {
            userChats[userId] = [
                {
                    role: "system",
                    content: "You are EDITH AI. Help students clearly. Summarize when requested. Analyze uploaded files. Keep answers clean, scannable, and markdown compliant."
                }
            ];
            
            // Sync with DB if session is active
            if (sessionId && sessionId !== "null") {
                const existingSession = await Chat.findById(sessionId);
                if (existingSession && Array.isArray(existingSession.messages)) {
                    existingSession.messages.forEach(m => userChats[userId].push(m));
                }
            }
        }

        let finalPrompt = message || "";
        if (isSummarize === "true") {
            finalPrompt = `Provide a clear, scannable structural summary of this note:\n\n${message}`;
        }
        finalPrompt += fileContext ? `\n\nContext Attachments:\n${fileContext}` : '';

        userChats[userId].push({ role: "user", content: finalPrompt });

        if (userChats[userId].length > MAX_HISTORY) {
            userChats[userId] = [userChats[userId][0], ...userChats[userId].slice(-MAX_HISTORY)];
        }

        // Trigger dynamic API streaming request
        const stream = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: userChats[userId].map(m => ({ role: m.role, content: m.content })),
            stream: true
        });

        let fullReply = "";
        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) {
                fullReply += content;
                res.write(content); // Pushes bits straight to frontend live streaming frame
            }
        }
        res.end();

        // Save persistent records to Mongo Layer
        userChats[userId].push({ role: "assistant", content: fullReply });

        await Chat.findByIdAndUpdate(activeChatSessionId, {
            $push: {
                messages: [
                    { role: "user", content: message || "[Uploaded Structural Documents Matrix]" },
                    { role: "assistant", content: fullReply }
                ]
            }
        });

        // Cleanup temp file buffers
        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }

    } catch (err) {
        console.error("❌ Intelligence Layer Core Failure:", err);
        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        if (!res.headersSent) {
            res.status(500).write("AI pipeline communication vector failure.");
        }
        res.end();
    }
});

app.get("/api/history", auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20);
        res.json(chats);
    } catch (err) {
        res.status(500).json({ error: "Failed to extract historical chat vectors." });
    }
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

app.listen(PORT, () => {
    console.log(`🚀 EDITH Engine Matrix active on port ${PORT}`);
});
