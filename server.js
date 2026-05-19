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
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "secret123";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =====================
// ✅ MongoDB
// =====================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err.message));

// =====================
// ✅ Models
// =====================
const User = mongoose.model("User", new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
}));

// 👉 Chat session (like sidebar)
const ChatSession = mongoose.model("ChatSession", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  title: String,
  createdAt: { type: Date, default: Date.now }
}));

// 👉 Messages
const Message = mongoose.model("Message", new mongoose.Schema({
  chatId: mongoose.Schema.Types.ObjectId,
  role: String,
  content: String,
  createdAt: { type: Date, default: Date.now }
}));

// =====================
// ✅ Auth
// =====================
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// =====================
// ✅ Upload
// =====================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// =====================
// ✅ AI
// =====================
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// =====================
// ✅ AUTH ROUTES
// =====================
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  const hash = await bcrypt.hash(password, 10);
  await User.create({ username, password: hash });

  res.json({ message: "Registered" });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: "User not found" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign({ id: user._id }, JWT_SECRET);

  res.json({ token });
});

// =====================
// ✅ CREATE CHAT
// =====================
app.post("/api/chat/new", auth, async (req, res) => {
  const chat = await ChatSession.create({
    userId: req.user.id,
    title: "New Chat"
  });

  res.json(chat);
});

// =====================
// ✅ GET ALL CHATS (sidebar)
// =====================
app.get("/api/chats", auth, async (req, res) => {
  const chats = await ChatSession.find({ userId: req.user.id })
    .sort({ createdAt: -1 });

  res.json(chats);
});

// =====================
// ✅ GET MESSAGES
// =====================
app.get("/api/chat/:id", auth, async (req, res) => {
  const messages = await Message.find({ chatId: req.params.id })
    .sort({ createdAt: 1 });

  res.json(messages);
});

// =====================
// ✅ MAIN CHAT
// =====================
app.post("/api/chat/:id", auth, upload.array("files"), async (req, res) => {
  const chatId = req.params.id;
  const message = req.body.message;

  // Load history
  const history = await Message.find({ chatId })
    .sort({ createdAt: 1 })
    .limit(20);

  const messages = [
    {
      role: "system",
      content: "You are Student AI. Answer clearly."
    },
    ...history.map(m => ({
      role: m.role,
      content: m.content
    })),
    {
      role: "user",
      content: message
    }
  ];

  // Save user msg
  await Message.create({
    chatId,
    role: "user",
    content: message
  });

  // STREAM
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Transfer-Encoding": "chunked"
  });

  const stream = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    stream: true
  });

  let full = "";

  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content || "";
    full += text;
    res.write(text);
  }

  res.end();

  // Save AI reply
  await Message.create({
    chatId,
    role: "assistant",
    content: full
  });

  // Auto title generate
  const chat = await ChatSession.findById(chatId);
  if (chat.title === "New Chat") {
    chat.title = message.substring(0, 30);
    await chat.save();
  }
});

// =====================
app.listen(PORT, () => {
  console.log(`🔥 http://localhost:${PORT}`);
});
