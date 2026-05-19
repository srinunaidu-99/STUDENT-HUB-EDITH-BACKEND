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
        unique: true // Expected to be the user's valid email address for OTP routing
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
        user: process.env.EMAIL_USER, // Your Gmail account
        pass: process.env.EMAIL_PASS  // Your 16-character Google App Password
    }
});

// In-memory runtime cache for handling short-lived OTP token verification state
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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB individual file upper boundary
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
        await User.create({
            username,
            password: hashedPassword
        });

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

// --- REAL OTP PASSWORD RECOVERY PIPELINE ---

// Step 1: Generate and Send Real OTP Code
app.post("/api/forgot-password/request", async (req, res) => {
    try {
        const { contact } = req.body; // Expecting user email input vector
        if (!contact) {
            return res.status(400).json({ error: "Target destination parameter missing." });
        }

        // Verify user exists before sending an OTP
        const userExists = await User.findOne({ username: contact });
        if (!userExists) {
            return res.status(404).json({ error: "No account profile mapping found for this email address." });
        }

        // Generate secure 6-digit dynamic OTP
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save state to transient verification map (Expires in 5 minutes)
        otpCache[contact] = {
            otp: generatedOtp,
            expiresAt: Date.now() + 5 * 60 * 1000,
            verified: false
        };

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: contact,
            subject: "EDITH AI - Reset Security Credentials Token Verification",
            html: `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: auto; padding: 30px; background-color: #0a0b17; color: #f3f4f6; border-radius: 16px; border: 1px solid #1e1b4b;">
                    <h2 style="color: #6366f1; text-align: center; font-size: 22px; font-weight: 700; margin-bottom: 20px;">EDITH Identity Verification</h2>
                    <p style="font-size: 14px; color: #9ca3af; line-height: 1.6;">An operator has requested a security modification sequence for this communication node. Enter this authorization token to confirm access:</p>
                    <div style="font-size: 28px; font-weight: 700; background: linear-gradient(135deg, #1e1b4b, #311042); padding: 16px; border-radius: 12px; text-align: center; letter-spacing: 6px; color: #a5b4fc; margin: 25px 0; border: 1px solid rgba(99,102,241,0.3);">
                        ${generatedOtp}
                    </div>
                    <p style="font-size: 12px; color: #6b7280; text-align: center; margin-top: 20px;">Security threshold duration: This unique token will expire inside 5 minutes.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        return res.json({ message: "Verification sequence dispatched to your verified email node." });

    } catch (err) {
        console.error("Mail Network Infrastructure Failure:", err);
        res.status(500).json({ error: "Failed to dispatch outgoing security token." });
    }
});

// Step 2: Validate Dispatched User Token
app.post("/api/forgot-password/verify", async (req, res) => {
    try {
        const { contact, code } = req.body;
        const record = otpCache[contact];

        if (!record) {
            return res.status(400).json({ error: "No recovery request pipeline initiated for this node." });
        }
        if (Date.now() > record.expiresAt) {
            delete otpCache[contact];
            return res.status(400).json({ error: "Security validation lifetime window expired." });
        }
        if (record.otp !== code.trim()) {
            return res.status(400).json({ error: "Security credential validation mismatch." });
        }

        record.verified = true;
        return res.json({ message: "Identity state approved. Proceed to structural adjustment." });
    } catch (err) {
        res.status(500).json({ error: "Token authorization module failure." });
    }
});

// Step 3: Mutate Persistent Core Password Mapping
app.post("/api/forgot-password/reset", async (req, res) => {
    try {
        const { contact, password } = req.body;
        const record = otpCache[contact];

        if (!record || !record.verified) {
            return res.status(403).json({ error: "Unauthorized state access mutation rejected." });
        }

        const user = await User.findOne({ username: contact });
        if (!user) {
            return res.status(404).json({ error: "User signature matrix reference lost." });
        }

        // Apply encryption modification to persistence stack
        user.password = await bcrypt.hash(password, 10);
        await user.save();

        // Wipe transient verification block from memory allocation maps
        delete otpCache[contact];

        return res.json({ message: "Database structural mutation successfully finalized." });
    } catch (err) {
        res.status(500).json({ error: "System mutation update failure." });
    }
});

// --- CONVERSATIONAL MATRIX STREAMS ---
app.post("/api/chat", auth, upload.array("files", 5), async (req, res) => {
    const uploadedFiles = req.files || [];
    try {
        const { message, isSummarize } = req.body;
        const userId = req.user.id;

        if (!message && uploadedFiles.length === 0) {
            return res.status(400).json({ error: "Empty request context arrays" });
        }

        // Ingest and extract context strings from standard file paths
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
            const legacyChats = await Chat.find({ userId }).sort({ createdAt: -1 }).limit(5);
            userChats[userId] = [
                {
                    role: "system",
                    content: "You are EDITH AI. Help students clearly. Summarize when requested. Analyze uploaded files. Keep answers clean, scannable, and markdown compliant."
                }
            ];

            if (legacyChats.length > 0) {
                for (const session of legacyChats.reverse()) {
                    if (Array.isArray(session.messages)) {
                        session.messages.forEach(m => userChats[userId].push(m));
                    }
                }
            }
        }

        let finalPrompt = message || "";
        if (isSummarize === "true") {
            finalPrompt = `Provide a clear, scannable structural summary of this note:\n\n${message}`;
        }
        finalPrompt += fileContext ? `\n\nContext Attachments:\n${fileContext}` : '';

        userChats[userId].push({ role: "user", content: finalPrompt });

        // Maintain operational context sizing constraints
        if (userChats[userId].length > MAX_HISTORY) {
            userChats[userId] = [userChats[userId][0], ...userChats[userId].slice(-MAX_HISTORY)];
        }

        // Initialize Chunked Network Transfer Stream
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        });

        const stream = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: userChats[userId],
            stream: true
        });

        let fullReply = "";
        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) {
                fullReply += content;
                res.write(content);
            }
        }
        res.end();

        // Append finalized message payload matrices to arrays
        userChats[userId].push({ role: "assistant", content: fullReply });

        await Chat.create({
            userId,
            messages: [
                { role: "user", content: message || "[Uploaded Structural Documents Matrix]" },
                { role: "assistant", content: fullReply }
            ]
        });

        // Unlink and garbage collect physical temporary filesystem buffers
        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }

    } catch (err) {
        console.error("❌ Intelligence Layer Core Failure:", err);
        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        if (!res.headersSent) {
            res.status(500).json({ error: "AI pipeline communication vector failure." });
        }
    }
});

// Fetch authentic operational user message indexes
app.get("/api/history", auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20);
        res.json(chats);
    } catch (err) {
        res.status(500).json({ error: "Failed to extract historical chat vectors." });
    }
});

// App Engine Entry Point
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

app.listen(PORT, () => {
    console.log(`🚀 EDITH Engine Matrix active on port ${PORT}`);
});
