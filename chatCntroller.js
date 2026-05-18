import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Idi the most important part! AI ki rules ikkade set chestam.
const SYSTEM_PROMPT = `You are a highly helpful, friendly, and expert AI tutor for students. 
Follow these strict rules for every response:
1. Language Match: Always respond in the EXACT same language and script the student uses. If they use Tenglish (Telugu in English script), reply dynamically in Tenglish. If Hindi, reply in Hindi.
2. Simple Explanations: Explain complex concepts very simply, using real-life examples. Avoid heavy jargon.
3. Notes Generation: Always provide a well-structured "Notes" section at the end of your explanation. Use Markdown (## headings, bold text, and bullet points) so it looks neat.
4. Diagrams (Mermaid.js): Whenever a concept can be visualized (like a process, architecture, lifecycle, or flowchart), generate a Mermaid diagram. Enclose the diagram code STRICTLY in a markdown block like this:
\`\`\`mermaid
graph TD
  A[Step 1] --> B[Step 2]
\`\`\``;

export const chatWithAI = async (req, res) => {
  try {
    const { message } = req.body;

    // OpenAI standard chat completion structure
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Updated to the correct standard fast/cheap model name
      messages: [
        { role: "system", content: SYSTEM_PROMPT }, // Giving AI its rules
        { role: "user", content: message }          // Student's actual doubt
      ],
      temperature: 0.7, // 0.7 is good for creative yet accurate tutoring
    });

    res.json({
      reply: response.choices[0].message.content, // Extracting the AI's text
    });

  } catch (error) {
    console.error("OpenAI API Error:", error);

    res.status(500).json({
      error: "AI request failed. Please try again.",
      details: error.message
    });
  }
};