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

// Correctly point to the root directory (.env is one folder up from /backend)
dotenv.config({
    path: path.resolve(__dirname, "../.env")
});

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "studenthub_secret";

// Global Middleware Config
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    exposedHeaders: ['X-Session-Id']
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// --- DATABASE CONNECTION ---
mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/studenthub"
)
.then(() => {
    console.log("✅ MongoDB Connected Successfully");
})
.catch((err) => {
    console.error("❌ Mongo Connection Error:", err.message);
});

// --- MONGOOSE SCHEMAS & MODELS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});
const User = mongoose.model("User", userSchema);

const chatSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    messages: Array,
    createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model("Chat", chatSchema);

// --- SECURE AUTHENTICATION MIDDLEWARE ---
function auth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "No token provided" });

        const token = authHeader.split(" ")[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token structure" });
    }
}

// --- MULTI-PART FILE UPLOAD SYSTEM CONFIG ---
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
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
// Ensure this route is positioned after your 'upload' middleware declaration
app.post("/api/chat", auth, upload.array("files", 5), async (req, res) => {
    const userId = req.user.id;
    const { message, sessionId, isSummarize } = req.body;
    const uploadedFiles = req.files || [];

    try {
        // 1. Set headers BEFORE any processing
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");

        // 2. Session & File Logic
        let activeChatSessionId = sessionId;
        if (!activeChatSessionId || activeChatSessionId === "null") {
            const newChatRecord = await Chat.create({ userId, messages: [] });
            activeChatSessionId = newChatRecord._id.toString();
        }
        res.setHeader("X-Session-Id", activeChatSessionId);

        // Process files here... (keep your existing file processing logic)

        // 3. Stream from Groq
        const stream = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [/* Your history array logic */],
            stream: true
        });

        // 4. Send chunks
        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) res.write(content);
        }

        // 5. Signal Completion
        res.end(); 

    } catch (err) {
        console.error("❌ Neural Bridge Error:", err);
        // Only attempt to send error if headers aren't already flushed
        if (!res.headersSent) {
            res.status(500).json({ error: "Pipeline failure" });
        } else {
            res.end();
        }
    }
});
app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "Invalid identity credentials" });
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Invalid identity credentials" });
        
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, username: user.username });
    } catch (err) {
        res.status(500).json({ error: "Login fault" });
    }
});

// --- ULTRA-LOW LATENCY CONVERSATIONAL MATRIX STREAMS ---
app.post("/api/chat", auth, upload.array("files", 5), async (req, res) => {
    const uploadedFiles = req.files || [];
    try {
        const { message, isSummarize, sessionId } = req.body;
        const userId = req.user.id;

        if (!message && uploadedFiles.length === 0) {
            return res.status(400).json({ error: "Empty request" });
        }

        let activeChatSessionId = sessionId;
        if (!activeChatSessionId || activeChatSessionId === "null" || activeChatSessionId === "undefined") {
            const newChatRecord = await Chat.create({ userId, messages: [] });
            activeChatSessionId = newChatRecord._id.toString();
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); 
        res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");
        res.setHeader("X-Session-Id", activeChatSessionId);
        res.flushHeaders(); 

        let fileContext = "";
        for (const file of uploadedFiles) {
            if (file.mimetype.includes("text") || file.mimetype.includes("json") || file.mimetype.includes("javascript") || file.mimetype.includes("html") || file.mimetype.includes("css")) {
                const data = fs.readFileSync(file.path, "utf-8");
                fileContext += `\n[File Contents Extraction: ${file.originalname}]\n${data}\n`;
            } else {
                fileContext += `\n[Meta Object Attachment Block: ${file.originalname}]\n`;
            }
        }

        userChats[userId] = [{
            role: "system",
            content: "You are EDITH AI. Help students clearly. Summarize when requested. Analyze uploaded files. Keep answers clean, scannable, and markdown compliant."
        }];
        
        if (activeChatSessionId) {
            const existingSession = await Chat.findById(activeChatSessionId);
            if (existingSession && Array.isArray(existingSession.messages)) {
                existingSession.messages.forEach(m => userChats[userId].push(m));
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
                res.write(content); 
            }
        }
        res.end();

        await Chat.findByIdAndUpdate(activeChatSessionId, {
            $push: {
                messages: {
                    $each: [
                        { role: "user", content: message || "[Uploaded Documents Matrix]" },
                        { role: "assistant", content: fullReply }
                    ]
                }
            }
        });

        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }

    } catch (err) {
        console.error("❌ Core AI Failure:", err);
        for (const f of uploadedFiles) {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        if (!res.headersSent) {
            res.status(500).write("AI pipeline communication error.");
        }
        res.end();
    }
});

app.delete("/api/chat/:id", auth, async (req, res) => {
    try {
        const chatId = req.params.id;
        const userId = req.user.id;
        await Chat.findOneAndDelete({ _id: chatId, userId: userId });
        if (userChats[userId]) delete userChats[userId];
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Purge fail" });
    }
});

app.get("/api/history", auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20);
        res.json(chats);
    } catch (err) {
        res.status(500).json({ error: "Failed history" });
    }
});

// --- SAFE STRIPPED HTML STRING ---
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Edith AI Assistant</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" />
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        brand: {
                            50: '#f5f3ff', 100: '#ede9fe', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca',
                        }
                    }
                }
            }
        }
    </script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; -webkit-font-smoothing: antialiased; }
        .chat-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
        .chat-scroll::-webkit-scrollbar-track { background: transparent; }
        .dark .chat-scroll::-webkit-scrollbar-thumb { background: #27272a; border-radius: 99px; }
        html:not(.dark) .chat-scroll::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 99px; }
        .prose-content p { margin-bottom: 0.75rem; }
        .prose-content p:last-child { margin-bottom: 0; }
        .prose-content ul { list-style-type: disc; margin-left: 1.25rem; margin-bottom: 0.75rem; }
        .prose-content ol { list-style-type: decimal; margin-left: 1.25rem; margin-bottom: 0.75rem; }
        .code-block-container { position: relative; margin: 16px 0; border-radius: 12px; overflow: hidden; border: 1px solid #27272a; }
        html:not(.dark) .code-block-container { border: 1px solid #e2e8f0; }
        pre { background: #09090b !important; padding: 16px; overflow-x: auto; margin: 0; }
        html:not(.dark) pre { background: #f8fafc !important; }
        code { color: #f4f4f5; font-size: 0.875rem; font-family: ui-monospace, monospace; }
        html:not(.dark) code { color: #0f172a; }
        .dot { animation: bouncePoint 1.4s infinite ease-in-out; width: 6px; height: 6px; background-color: #6366f1; border-radius: 50%; display: inline-block; }
        .dot:nth-child(2) { animation-delay: 0.2s; }
        .dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bouncePoint { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }
        .download-pdf-trigger { margin-top: 12px; width: max-content; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); font-size: 12px; font-weight: 600; border-radius: 10px; color: #818cf8; transition: all 0.2s; cursor: pointer; }
        .download-pdf-trigger:hover { background: #4f46e5; color: white; transform: translateY(-1px); }
    </style>
</head>
<body class="w-screen h-screen flex dark:bg-[#09090b] bg-slate-50 text-slate-900 dark:text-zinc-100 transition-colors duration-200 overflow-hidden">
    <div id="sidebarOverlay" onclick="toggleSidebar(false)" class="hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"></div>
    <aside id="sidebar" class="fixed inset-y-0 left-0 w-72 -translate-x-full lg:translate-x-0 lg:relative z-50 flex flex-col h-full dark:bg-[#121214] bg-white border-r dark:border-zinc-800 border-slate-200 transition-transform duration-300 ease-in-out">
        <div class="p-4 space-y-4 shrink-0">
            <div class="flex items-center justify-between px-1">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-xl bg-brand-600 flex items-center justify-center text-white font-bold text-base shadow-md shadow-brand-500/20">E</div>
                    <span class="text-lg font-bold tracking-tight dark:text-white text-slate-900">Edith <span class="text-brand-500 font-semibold">AI</span></span>
                </div>
            </div>
            <button onclick="createNewChat()" class="w-full h-11 flex items-center justify-center gap-2 text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 active:scale-[0.98] rounded-xl shadow-sm transition-all duration-200">
                <i class="fa-solid fa-plus text-xs"></i> New Conversation
            </button>
        </div>
        <div class="px-5 py-2.5 border-b dark:border-zinc-800 border-slate-100 flex justify-between items-center text-xs font-bold uppercase tracking-wider dark:text-zinc-500 text-slate-400 shrink-0">
            <span>History Matrix</span>
            <span id="chatCounter" class="bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 rounded-md font-mono text-xs text-brand-500">0</span>
        </div>
        <div id="chatHistoryList" class="flex-1 overflow-y-auto p-3 space-y-1 chat-scroll">
            <div class="text-center py-8 text-xs text-zinc-400 font-medium animate-pulse">Loading history pipeline...</div>
        </div>
        <div class="p-4 border-t dark:border-zinc-800 border-slate-200 flex items-center justify-between dark:bg-zinc-900/20 bg-slate-50/50 shrink-0">
            <div class="flex items-center gap-3 overflow-hidden">
                <div class="w-9 h-9 rounded-xl bg-zinc-800 dark:bg-zinc-800 border border-zinc-700 text-zinc-200 flex items-center justify-center text-sm font-bold shadow-sm shrink-0" id="userBadge">UR</div>
                <div class="overflow-hidden">
                    <span class="block text-sm font-bold dark:text-zinc-200 text-slate-800 truncate" id="userNameFooter">Operator</span>
                    <span class="block text-[11px] font-medium text-zinc-500 truncate">Student Hub Plus</span>
                </div>
            </div>
        </div>
    </aside>

    <div class="flex-1 flex flex-col h-full overflow-hidden w-full relative">
        <header class="h-16 border-b dark:border-zinc-800 border-slate-200 flex justify-between items-center px-4 md:px-6 dark:bg-[#121214] bg-white shrink-0 z-10">
            <div class="flex items-center gap-3">
                <button onclick="toggleSidebar(true)" class="lg:hidden w-10 h-10 border dark:border-zinc-800 border-slate-200 rounded-xl flex items-center justify-center dark:text-zinc-300 text-slate-600 bg-transparent hover:bg-slate-50 dark:hover:bg-zinc-900 transition-colors">
                    <i class="fa-solid fa-bars text-sm"></i>
                </button>
                <div id="activeChatTitleHeader" class="hidden lg:block text-sm font-semibold text-slate-700 dark:text-zinc-300 max-w-md truncate">Ready to link pipelines</div>
            </div>
            <div class="flex items-center gap-3">
                <button onclick="switchDashboardTheme()" class="w-9 h-9 rounded-xl border dark:border-zinc-800 border-slate-200 flex items-center justify-center text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-900 transition-all">
                    <i id="themeToggleIcon" class="fa-solid fa-moon text-sm"></i>
                </button>
                <div class="text-xs font-semibold text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-xl flex items-center gap-1.5 shadow-sm">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Active
                </div>
            </div>
        </header>

        <main id="chatWindow" class="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 chat-scroll dark:bg-[#09090b] bg-slate-50/40 flex flex-col"></main>

        <footer class="p-4 dark:bg-[#121214] bg-white border-t dark:border-zinc-800 border-slate-200 shrink-0">
            <div class="max-w-3xl mx-auto w-full">
                <div class="flex flex-wrap items-center gap-3 mb-2 px-1">
                    <button onclick="toggleSummarizeMode()" id="summarizeToggleBtn" class="text-xs dark:text-zinc-400 text-slate-500 border border-slate-200 dark:border-zinc-800 px-2.5 py-1 rounded-lg hover:dark:text-indigo-400 transition-colors flex items-center gap-1.5 font-bold">
                        Summarize Mode: <span id="summarizeBadge" class="text-slate-400">OFF</span>
                    </button>
                    <label class="text-xs dark:text-zinc-400 text-slate-500 hover:dark:text-zinc-200 hover:text-slate-700 cursor-pointer flex items-center gap-1.5 font-bold transition-colors">
                        <i class="fa-solid fa-paperclip text-xs text-brand-500"></i> Attach Media
                        <input type="file" id="fileAttachment" multiple class="hidden" onchange="handleFileSelect()" />
                    </label>
                    <span id="fileBadgeLabel" class="text-xs text-brand-500 font-bold bg-brand-500/10 px-2 py-0.5 rounded-md hidden"></span>
                </div>
                <div class="flex items-center gap-2 relative bg-slate-100 dark:bg-zinc-900 border dark:border-zinc-800 border-slate-200 rounded-xl px-4 py-2 focus-within:ring-2 focus-within:ring-brand-500/20 focus-within:border-brand-500/50 transition-all duration-200">
                    <input type="text" id="userInputText" placeholder="Ask Edith anything..." class="w-full bg-transparent outline-none py-1.5 pr-24 text-sm dark:text-zinc-100 text-slate-900 placeholder-slate-400 dark:placeholder-zinc-500 font-normal" onkeypress="if(event.key==='Enter')sendMessage()" />
                    <div class="absolute right-2 flex items-center gap-1.5">
                        <button onclick="toggleSpeech()" id="speechBtn" class="w-8 h-8 text-slate-400 dark:text-zinc-500 hover:text-brand-500 rounded-lg flex items-center justify-center transition-all"><i class="fa-solid fa-microphone text-sm"></i></button>
                        <button onclick="sendMessage()" class="w-8 h-8 bg-brand-600 hover:bg-brand-700 text-white rounded-lg flex items-center justify-center transition-all shadow-sm active:scale-95"><i class="fa-solid fa-paper-plane text-xs"></i></button>
                    </div>
                </div>
            </div>
        </footer>
    </div>

<script>
const API_URL = window.location.origin;
const chatWindow = document.getElementById("chatWindow");
const chatHistoryList = document.getElementById("chatHistoryList");
const activeChatTitleHeader = document.getElementById("activeChatTitleHeader");
let currentSessionId = null, cachedSessionsList = [], voiceRecognitionInstance = null, isVoiceRecording = false, isSummarizeActive = false;

function initDashboardTheme() {
    const activeTheme = localStorage.getItem('edith-theme') || 'dark';
    document.documentElement.classList.toggle('dark', activeTheme === 'dark');
    document.getElementById("themeToggleIcon").className = activeTheme === 'dark' ? "fa-solid fa-sun text-sm text-amber-400" : "fa-solid fa-moon text-sm text-slate-600";
}
function switchDashboardTheme() {
    localStorage.setItem('edith-theme', document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    initDashboardTheme();
}
initDashboardTheme();

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechLib = window.SpeechRecognition || window.webkitSpeechRecognition;
    voiceRecognitionInstance = new SpeechLib();
    voiceRecognitionInstance.onstart = () => { isVoiceRecording = true; document.getElementById("speechBtn").classList.add("text-red-500", "animate-pulse"); };
    voiceRecognitionInstance.onend = () => { isVoiceRecording = false; document.getElementById("speechBtn").classList.remove("text-red-500", "animate-pulse"); };
    voiceRecognitionInstance.onresult = (e) => { document.getElementById("userInputText").value = e.results[0][0].transcript; };
}
function toggleSpeech() { if (!voiceRecognitionInstance) return alert("Speech unsupported."); isVoiceRecording ? voiceRecognitionInstance.stop() : voiceRecognitionInstance.start(); }
function toggleSidebar(open) { document.getElementById("sidebar").classList.toggle("-translate-x-full", !open); document.getElementById("sidebarOverlay").classList.toggle("hidden", !open); }

function toggleSummarizeMode() {
    isSummarizeActive = !isSummarizeActive;
    const badge = document.getElementById("summarizeBadge");
    badge.textContent = isSummarizeActive ? "ON" : "OFF";
    badge.className = isSummarizeActive ? "text-indigo-500 font-bold" : "text-slate-400";
}

window.onload = () => { marked.setOptions({ breaks: true, gfm: true }); loadChatSessions(true); };

async function apiCall(endpoint, config = {}) {
    const headers = Object.assign({}, config.headers || {}, { "Authorization": "Bearer " + (localStorage.getItem("token") || "dummy") });
    if (!(config.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return await fetch(API_URL + endpoint, Object.assign({}, config, { headers }));
}

async function loadChatSessions(autoLoadFirst = false) {
    try {
        const response = await apiCall("/api/history");
        if (!response.ok) throw new Error();
        cachedSessionsList = await response.json();
        renderSidebarList(cachedSessionsList);
        if (autoLoadFirst && cachedSessionsList.length > 0) selectSession(cachedSessionsList[0]._id);
        else if (cachedSessionsList.length === 0) showEmptyStateWelcome();
    } catch (err) { showEmptyStateWelcome(); }
}

function renderSidebarList(sessions) {
    chatHistoryList.innerHTML = "";
    document.getElementById("chatCounter").textContent = sessions.length;
    if (sessions.length === 0) {
        chatHistoryList.innerHTML = '<div class="text-center py-8 text-xs text-zinc-500">No context logs found.</div>';
        return;
    }
    sessions.forEach(session => {
        const isActive = session._id === currentSessionId;
        let title = session.messages && session.messages[0] ? session.messages[0].content : 'Untitled Chat';
        if (title.length > 22) title = title.substring(0, 22) + "...";
        if(isActive) activeChatTitleHeader.textContent = title;
        
        const div = document.createElement("div");
        div.className = "group w-full flex items-center justify-between px-3 py-2.5 my-0.5 text-sm rounded-xl cursor-pointer " + (isActive ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 font-semibold border border-brand-500/20' : 'text-zinc-400 hover:bg-zinc-900/60');
        div.onclick = () => selectSession(session._id);
        div.innerHTML = '<span class="truncate flex items-center gap-2.5"><i class="fa-regular fa-message text-xs opacity-70"></i><span class="truncate">' + title + '</span></span><button onclick="deleteSession(event, \'' + session._id + '\')" class="p-1 text-zinc-500 hover:text-red-500 opacity-0 group-hover:opacity-100"><i class="fa-regular fa-trash-can text-xs"></i></button>';
        chatHistoryList.appendChild(div);
    });
}

function createNewChat() { currentSessionId = null; chatWindow.innerHTML = ""; activeChatTitleHeader.textContent = "New Line"; showEmptyStateWelcome(); }
function selectSession(id) { currentSessionId = id; renderSidebarList(cachedSessionsList); loadActiveMessages(); toggleSidebar(false); }

async function deleteSession(event, id) {
    event.stopPropagation();
    if (!confirm("Delete context loop?")) return;
    try {
        await apiCall("/api/chat/" + id, { method: "DELETE" });
        if (currentSessionId === id) createNewChat();
        loadChatSessions(true);
    } catch (err) {}
}

function loadActiveMessages() {
    if (!currentSessionId) return;
    const session = cachedSessionsList.find(s => s._id === currentSessionId);
    chatWindow.innerHTML = "";
    if (session && session.messages) session.messages.forEach(msg => insertMessageBubble(msg.role, msg.content));
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function showEmptyStateWelcome() {
    chatWindow.innerHTML = '<div id="welcomeScreen" class="flex flex-col items-center justify-center flex-1 max-w-md mx-auto text-center space-y-3 my-auto"><div class="w-12 h-12 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-500 text-xl"><i class="fa-solid fa-brain"></i></div><h3 class="text-base font-bold">Ask EDITH anything to generate notes</h3></div>';
}

function insertMessageBubble(role, content) {
    const welcome = document.getElementById("welcomeScreen"); if(welcome) welcome.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "flex gap-3 w-full max-w-3xl mx-auto py-2 " + (role === 'user' ? 'flex-row-reverse' : 'flex-row');
    
    const bubble = document.createElement("div");
    bubble.className = "rounded-2xl px-4 py-3 text-sm md:text-base leading-relaxed break-words " + (role === 'user' ? 'bg-brand-600 text-white ml-auto' : 'dark:bg-[#121214] bg-white border dark:border-zinc-800 border-slate-200 prose-content');
    
    if (role === 'user') bubble.textContent = content;
    else {
        bubble.innerHTML = marked.parse(content);
        attachCodeBlockCopyLogic(bubble);
        injectDownloadActionTrigger(bubble);
    }
    wrapper.appendChild(bubble); chatWindow.appendChild(wrapper);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return bubble;
}

function attachCodeBlockCopyLogic(container) {
    container.querySelectorAll("pre").forEach(pre => {
        const wrapper = document.createElement("div"); wrapper.className = "code-block-container";
        const btn = document.createElement("button"); btn.className = "absolute top-2.5 right-2.5 bg-zinc-900 border text-zinc-400 text-xs px-2.5 py-1.5 rounded-lg";
        btn.innerHTML = "Copy"; btn.onclick = () => { navigator.clipboard.writeText(pre.innerText); btn.innerHTML = "Copied"; setTimeout(() => btn.innerHTML="Copy", 2000); };
        pre.parentNode.insertBefore(wrapper, pre); wrapper.appendChild(pre); wrapper.appendChild(btn);
    });
}

function injectDownloadActionTrigger(container) {
    if (container.querySelector(".download-pdf-trigger")) return;
    const btn = document.createElement("button"); btn.className = "download-pdf-trigger"; btn.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Download Notes PDF';
    btn.onclick = () => {
        const f = document.createElement("div"); f.style.padding = "40px"; f.style.background = "#fff"; f.style.color = "#000"; f.innerHTML = container.innerHTML;
        f.querySelectorAll("button").forEach(b => b.remove());
        html2pdf().from(f).set({ margin: 15, filename: 'EDITH-Notes.pdf', html2canvas: { scale: 2 }, jsPDF: { format: 'a4' } }).save();
    };
    container.appendChild(btn);
}

async function sendMessage() {
    const input = document.getElementById("userInputText"), fileSelector = document.getElementById("fileAttachment"), text = input.value.trim();
    if (!text && fileSelector.files.length === 0) return;
    
    input.value = "";
    if (text) insertMessageBubble('user', text);
    
    const bubble = insertMessageBubble('assistant', "<em>Syncing Core Matrix...</em>");
    try {
        const formData = new FormData();
        formData.append("message", text);
        formData.append("isSummarize", isSummarizeActive);
        if (currentSessionId) formData.append("sessionId", currentSessionId);
        for (let i = 0; i < fileSelector.files.length; i++) formData.append("files", fileSelector.files[i]);

        const response = await apiCall("/api/chat", { method: "POST", body: formData });
        const incomingId = response.headers.get("X-Session-Id");
        if (incomingId && !currentSessionId) currentSessionId = incomingId;

        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8");
        let chunkedText = "";
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            chunkedText += decoder.decode(value, { stream: true });
            bubble.innerHTML = marked.parse(chunkedText);
            chatWindow.scrollTop = chatWindow.scrollHeight;
        }
        attachCodeBlockCopyLogic(bubble); injectDownloadActionTrigger(bubble);
        clearFileSelector(); loadChatSessions(false);
    } catch (err) { bubble.innerHTML = "<span class='text-red-500'>Connection pipeline breakdown.</span>"; }
}

function handleFileSelect() {
    const f = document.getElementById("fileAttachment"), lbl = document.getElementById("fileBadgeLabel");
    lbl.textContent = "(" + f.files.length + " selected)"; lbl.classList.toggle("hidden", f.files.length === 0);
}
function clearFileSelector() { document.getElementById("fileAttachment").value = ""; document.getElementById("fileBadgeLabel").classList.add("hidden"); }
</script>
</body>
</html>
`;

app.get("/", (req, res) => {
    res.send(htmlTemplate);
});

app.listen(PORT, () => {
    console.log(`🚀 Single Server Engine running on port ${PORT}`);
});
