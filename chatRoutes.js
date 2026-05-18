import express from "express";
import { chatWithAI } from "../controllers/chatController.js";

const router = express.Router();

// Test cheyadaniki oka simple GET route (Browser lo check cheskodaniki)
router.get("/", (req, res) => {
  res.json({ message: "AI Tutor Chat API is running smoothly! 🚀" });
});

// Nuvvu rasina actual POST route (Frontend nundi message receive cheskodaniki)
router.post("/", chatWithAI);

export default router;