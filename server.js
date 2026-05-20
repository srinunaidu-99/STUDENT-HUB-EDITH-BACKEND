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
app.post("/api/register", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: "User profile already registered" });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        res.json({ message: "Registration successful" });
    } catch (err) {
        res.status(500).json({ error: "Registration failure" });
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
        if (!activeChatSessionId || activeChatSessionId === "null") {
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

        if (!userChats[userId]) {
            userChats[userId] = [{
                role: "system",
                content: "You are EDITH AI. Help students clearly. Summarize when requested. Analyze uploaded files. Keep answers clean, scannable, and markdown compliant."
            }];
            
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

        userChats[userId].push({ role: "assistant", content: fullReply });

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
        if (!res.headersSent) res.status(500).write("AI pipeline communication error.");
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

// --- FRONTEND GENERATION ENGINE WITH INSTANT UI FIXES ---
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EDITH - Intelligence Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" />
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght=400;500;600;700&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, #030712 70%); overflow: hidden; }
        .chat-container::-webkit-scrollbar, .sidebar-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
        .chat-container::-webkit-scrollbar-track, .sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
        .chat-container::-webkit-scrollbar-thumb, .sidebar-scroll::-webkit-scrollbar-thumb { background: rgba(99, 102, 241, 0.15); border-radius: 10px; }
        @keyframes pulseGlow {
            0%, 100% { transform: scale(1); box-shadow: 0 0 25px 2px rgba(99, 102, 241, 0.4), 0 0 50px 10px rgba(168, 85, 247, 0.2); }
            50% { transform: scale(1.03); box-shadow: 0 0 40px 8px rgba(99, 102, 241, 0.6), 0 0 70px 20px rgba(168, 85, 247, 0.4); }
        }
        .edith-orb { animation: pulseGlow 4s ease-in-out infinite; background: linear-gradient(135deg, #6366f1, #a855f7); }
        @keyframes slideIn { from { opacity: 0; transform: translateY(16px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .animate-msg { animation: slideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .glass-panel { background: rgba(10, 11, 23, 0.75); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.06); }
        .ai-bubble { background: rgba(23, 24, 51, 0.6); border: 1px solid rgba(99, 102, 241, 0.25); color: #f3f4f6; border-radius: 20px 20px 20px 4px; display: flex; flex-col; gap: 12px; }
        .user-bubble { background: linear-gradient(135deg, #4f46e5, #3730a3); color: white; border-radius: 20px 20px 4px 20px; box-shadow: 0 4px 16px rgba(79, 70, 229, 0.25); }
        .history-active { background: rgba(255, 255, 255, 0.12) !important; color: #ffffff !important; font-weight: 600 !important; border-left: 3px solid #6366f1 !important; }
        pre { background: #020617 !important; padding: 14px; border-radius: 10px; overflow-x: auto; border: 1px solid rgba(255, 255, 255, 0.05); margin: 8px 0; }
        code { color: #a5b4fc; font-size: 0.85rem; }
        .delete-chat-btn { opacity: 0; transition: opacity 0.2s ease; cursor: pointer; }
        .history-item-wrapper:hover .delete-chat-btn { opacity: 1; }
        .download-pdf-trigger { margin-top: 12px; width: max-content; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgba(99, 102, 241, 0.25); border: 1px solid rgba(99, 102, 241, 0.5); font-size: 12px; font-weight: 600; border-radius: 10px; color: #a5b4fc; transition: all 0.2s; cursor: pointer; }
        .download-pdf-trigger:hover { background: #4f46e5; color: white; transform: translateY(-1px); }
    </style>
</head>
<body class="text-gray-100 min-h-screen flex items-center justify-center p-0 sm:p-4">
<div class="w-full max-w-6xl h-screen sm:h-[92vh] flex glass-panel sm:rounded-3xl shadow-2xl relative overflow-hidden">
    <aside class="w-64 bg-black/20 flex flex-col h-full hidden lg:flex border-r border-white/5 transition-all">
        <div class="p-4 flex flex-col gap-2">
            <button onclick="createNewChatSession()" class="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-gray-200 hover:bg-white/5 rounded-xl transition-all font-medium bg-white/5 border border-white/10">
                <i class="fa-regular fa-pen-to-square text-base text-indigo-400"></i> New chat
            </button>
        </div>
        <div class="px-4 pt-4 pb-2"><span class="text-xs font-semibold text-gray-400 tracking-wider block uppercase">Recents</span></div>
        <div id="historyLogContainer" class="flex-1 overflow-y-auto px-2 pb-4 space-y-1 sidebar-scroll"></div>
    </aside>

    <div class="flex-1 flex flex-col h-full relative bg-transparent">
        <div class="p-4 border-b border-white/5 flex justify-between items-center bg-gray-950/20 px-6">
            <div class="flex items-center gap-3.5">
                <div class="edith-orb w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-lg">E</div>
                <div>
                    <h1 class="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-indigo-300 bg-clip-text text-transparent">EDITH AI</h1>
                    <p class="text-[10px] uppercase tracking-widest text-indigo-400 font-bold"><span class="w-1.5 h-1.5 bg-emerald-500 rounded-full inline-block animate-pulse mr-1.5"></span>System: Ready</p>
                </div>
            </div>
        </div>

        <div id="chatArea" class="flex-1 overflow-y-auto p-6 space-y-6 chat-container"></div>

        <div class="p-4 sm:p-6 bg-gray-950/40 border-t border-white/5 backdrop-blur-md">
            <div class="flex flex-wrap gap-2 mb-3.5 px-1">
                <button onclick="toggleSummarize()" id="sumBtn" class="px-4 py-1.5 rounded-full border border-white/10 hover:border-indigo-500/40 bg-white/5 text-[11px] font-medium flex items-center gap-2">
                    Summarize Notes: <span id="sumStatus" class="font-bold text-gray-400">OFF</span>
                </button>
                <label class="px-4 py-1.5 rounded-full border border-white/10 bg-white/5 text-[11px] font-medium cursor-pointer flex items-center gap-1.5">
                    <i class="fa-solid fa-paperclip text-indigo-400"></i> Attach Files
                    <input type="file" id="fileInput" multiple class="hidden" />
                </label>
            </div>
            <div class="flex gap-3 items-center relative">
                <input type="text" id="msg" placeholder="Ask EDITH anything..." class="w-full bg-gray-900/80 border border-white/10 focus:border-indigo-500/50 rounded-2xl pl-5 pr-16 py-4 outline-none text-sm text-gray-100" onkeypress="if(event.key==='Enter')sendMsg()" />
                <button onclick="sendMsg()" class="absolute right-3 w-10 h-10 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl flex items-center justify-center"><i class="fa-solid fa-paper-plane text-xs"></i></button>
            </div>
        </div>
    </div>
</div>

<script>
const API_BASE = window.location.origin;
const chatArea = document.getElementById("chatArea");
const historyLogContainer = document.getElementById("historyLogContainer");
let isSummarize = false, currentActiveSessionId = null, globallyCachedHistoryTree = [];

window.onload = () => { loadChatHistory(true); };

function renderBlankWelcomeInterface() {
    chatArea.innerHTML = \`<div id="welcomeScreen" class="flex flex-col justify-center items-center mt-24 text-center animate-msg"><div class="edith-orb w-20 h-20 rounded-3xl flex items-center justify-center text-3xl text-white mb-6"><i class="fa-solid fa-brain"></i></div><h2 class="text-2xl font-bold mb-2 text-white">Ask anything to generate and download PDF Notes!</h2></div>\`;
}

async function loadChatHistory(autoLoadFirstSession = false) {
    const token = localStorage.getItem("token") || "dummy";
    try {
        const response = await fetch(\`\${API_BASE}/api/history\`, { headers: { "Authorization": \`Bearer \${token}\` } });
        if (response.ok) {
            globallyCachedHistoryTree = await response.json();
            renderSidebarHistoryList(globallyCachedHistoryTree);
            if (autoLoadFirstSession && globallyCachedHistoryTree.length > 0) loadSelectedSessionStream(globallyCachedHistoryTree[0]._id);
            else if(globallyCachedHistoryTree.length === 0) renderBlankWelcomeInterface();
        } else { renderBlankWelcomeInterface(); }
    } catch (err) { renderBlankWelcomeInterface(); }
}

function renderSidebarHistoryList(historyArray) {
    if (!historyArray || historyArray.length === 0) {
        historyLogContainer.innerHTML = \`<div class="text-center py-8 text-[11px] text-gray-500">No sessions.</div>\`;
        return;
    }
    historyLogContainer.innerHTML = "";
    historyArray.forEach((session) => {
        let displayTitle = session.messages?.[0]?.content || "Untitled Chat";
        if (displayTitle.length > 20) displayTitle = displayTitle.substring(0, 20) + "...";

        const itemWrapper = document.createElement("div");
        itemWrapper.className = "flex items-center justify-between w-full relative group rounded-xl pr-2 hover:bg-white/5";

        const btn = document.createElement("button");
        btn.id = \`sidebar-session-\${session._id}\`;
        btn.onclick = () => loadSelectedSessionStream(session._id);
        btn.className = \`flex-1 text-left px-3 py-2.5 text-xs text-gray-300 rounded-xl truncate \${String(session._id) === String(currentActiveSessionId) ? 'history-active' : ''}\`;
        btn.innerText = displayTitle;

        itemWrapper.appendChild(btn);
        historyLogContainer.appendChild(itemWrapper);
    });
}

function loadSelectedSessionStream(sessionId) {
    currentActiveSessionId = sessionId;
    const session = globallyCachedHistoryTree.find(s => String(s._id) === String(sessionId));
    chatArea.innerHTML = "";
    if (session && session.messages) {
        session.messages.forEach(msg => appendMessageToUI(msg.content, msg.role === "user"));
    }
}

function createNewChatSession() { currentActiveSessionId = null; renderBlankWelcomeInterface(); }

async function sendMsg() {
    const input = document.getElementById("msg"), fileInput = document.getElementById("fileInput"), message = input.value.trim();
    if (!message && fileInput.files.length === 0) return;

    appendMessageToUI(message, true);
    input.value = "";

    const formData = new FormData();
    formData.append("message", message);
    formData.append("isSummarize", isSummarize);
    if (currentActiveSessionId) formData.append("sessionId", currentActiveSessionId);
    for (let f of fileInput.files) formData.append("files", f);

    // AI dynamic bubble placeholder create chesthunna build sheet framework loki
    const welcome = document.getElementById("welcomeScreen"); if (welcome) welcome.remove();
    const div = document.createElement("div"); div.className = "flex justify-start animate-msg w-full";
    const bubbleInner = document.createElement("div");
    bubbleInner.className = "p-5 max-w-[85%] text-sm ai-bubble break-words flex flex-col";
    bubbleInner.innerHTML = "<em>Thinking...</em>";
    div.appendChild(bubbleInner);
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;

    try {
        const res = await fetch(\`\${API_BASE}/api/chat\`, { method: "POST", headers: { "Authorization": "Bearer dummy" }, body: formData });
        const incomingSessionId = res.headers.get("X-Session-Id");
        if (incomingSessionId && !currentActiveSessionId) currentActiveSessionId = incomingSessionId;

        const reader = res.body.getReader(), decoder = new TextDecoder("utf-8");
        let accumulatedText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            accumulatedText += decoder.decode(value, { stream: true });
            bubbleInner.innerHTML = marked.parse(accumulatedText);
            chatArea.scrollTop = chatArea.scrollHeight;
        }
        
        // STREAMING COMPLETED! Ippudu button perfect ga container lo load chesthundi:
        injectDownloadActionTrigger(bubbleInner);
        loadChatHistory(false);
    } catch (err) { bubbleInner.innerHTML = "Pipeline Connection Mismatch Fault."; }
}

function injectDownloadActionTrigger(containerElement) {
    // Already button unte duplicate kakunda check chesthundi
    if (containerElement.querySelector(".download-pdf-trigger")) return;

    const btn = document.createElement("button");
    btn.className = "download-pdf-trigger";
    btn.innerHTML = \`<i class="fa-solid fa-file-pdf"></i> Download Notes PDF\`;
    
    btn.onclick = () => {
        const workingFrame = document.createElement("div");
        workingFrame.style.padding = "40px";
        workingFrame.style.color = "#000000";
        workingFrame.style.background = "#ffffff";
        workingFrame.style.fontFamily = "sans-serif";
        workingFrame.style.lineHeight = "1.6";
        workingFrame.innerHTML = containerElement.innerHTML;
        
        // Output sheet sheet format nundi action trigger elements ni clean chesthundi
        const innerBtn = workingFrame.querySelector(".download-pdf-trigger");
        if(innerBtn) innerBtn.remove();

        const configOptions = {
            margin: 15,
            filename: 'EDITH-AI-Notes.pdf',
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, logging: false, useCORS: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().from(workingFrame).set(configOptions).save();
    };
    containerElement.appendChild(btn);
}

function appendMessageToUI(text, isUser) {
    const welcome = document.getElementById("welcomeScreen"); if (welcome) welcome.remove();
    const div = document.createElement("div"); div.className = \`flex \${isUser ? "justify-end" : "justify-start"} animate-msg w-full\`;
    div.innerHTML = \`<div class="p-5 max-w-[85%] text-sm \${isUser ? "user-bubble" : "ai-bubble break-words flex flex-col"}"\> \${isUser ? text : marked.parse(text)}</div>\`;
    chatArea.appendChild(div); chatArea.scrollTop = chatArea.scrollHeight;
    
    const targetBubble = div.querySelector("div");
    if(!isUser && text.length > 0) {
        injectDownloadActionTrigger(targetBubble);
    }
    return targetBubble;
}

function toggleSummarize() { isSummarize = !isSummarize; document.getElementById("sumStatus").innerText = isSummarize ? "ON" : "OFF"; }
</script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Single Server Engine running on port ${PORT}`);
});
