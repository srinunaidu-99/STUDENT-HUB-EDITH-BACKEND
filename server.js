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

dotenv.config(); // ✅ FIXED

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "secret123";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ===================
// ✅ MongoDB
// ===================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err.message));

// ===================
// ✅ Models
// ===================
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
});

const chatSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  role: String,
  content: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Chat = mongoose.model("Chat", chatSchema);

// ===================
// ✅ Auth Middleware
// ===================
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

// ===================
// ✅ File Upload
// ===================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// ===================
// ✅ AI Client
// ===================
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// ===================
// ✅ REGISTER
// ===================
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  const hash = await bcrypt.hash(password, 10);
  await User.create({ username, password: hash });

  res.json({ message: "Registered" });
});

// ===================
// ✅ LOGIN
// ===================
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: "No user" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: "Wrong pass" });

  const token = jwt.sign({ id: user._id }, JWT_SECRET);

  res.json({ token });
});

// ===================
// ✅ CHAT (MAIN)
// ===================
app.post("/api/chat", auth, upload.array("files"), async (req, res) => {
  const userId = req.user.id;
  const message = req.body.message;

  // 🧠 Load history from DB
  const history = await Chat.find({ userId })
    .sort({ createdAt: 1 })
    .limit(20);

  const messages = [
    {
      role: "system",
      content: "You are Student AI. Answer clearly."
    },
    ...history.map(h => ({
      role: h.role,
      content: h.content
    })),
    {
      role: "user",
      content: message
    }
  ];

  // 📝 Save user msg
  await Chat.create({
    userId,
    role: "user",
    content: message
  });

  // 🚀 STREAM
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

  // 📝 Save AI reply
  await Chat.create({
    userId,
    role: "assistant",
    content: full
  });
});

// ===================
// ✅ GET HISTORY
// ===================
app.get("/api/history", auth, async (req, res) => {
  const chats = await Chat.find({ userId: req.user.id })
    .sort({ createdAt: 1 });

  res.json(chats);
});

// ===================
app.listen(PORT, () => {
  console.log(`🔥 http://localhost:${PORT}`);
});
