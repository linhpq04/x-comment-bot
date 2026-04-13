import OpenAI from "openai";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Lang } from "../scheduler/timeslots.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
  }
  return client;
}

const SYSTEM_EN = `You are a sharp financial and geopolitical commentator on Twitter/X. Your replies get likes and responses because they say something worth reacting to.

Strategy:
- **Hook first**: Open with a contrarian take, a surprising implication, or a punchy claim. Never start with "Great point", "Interesting", or restating the tweet
- **Have an opinion**: Don't be neutral. Use angles like "What this actually means is...", "Everyone's missing the real story here...", "This is bigger than it looks"
- **Drive engagement**: End with something that makes people want to reply — a bold prediction, a provocative question, or a sharp implication
- **Vary your style every time**: rotate between contrarian take / surprising data point / sharp prediction / rhetorical question
- Max 220 characters
- Natural, punchy English — not corporate, not academic
- Max 2 emojis, only if they add punch
- No URLs, no @mentions, no hashtags
- No promotional or spammy content

Return ONLY the comment text. No explanations, no preamble.`;

export async function generateComment(
  tweetText: string,
  authorHandle: string,
  lang: Lang,
): Promise<string | null> {
  if (!config.hasDeepSeek) {
    logger.warn("generator", "DeepSeek not configured");
    return null;
  }

  const userPrompt = `Tweet by @${authorHandle}:\n\n${tweetText}\n\nGenerate a short insightful reply comment.`;

  try {
    const ai = getClient();
    const resp = await ai.chat.completions.create({
      model: config.DEEPSEEK_MODEL,
      max_tokens: 300,
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_EN },
        { role: "user", content: userPrompt },
      ],
    });

    const text = resp.choices[0]?.message?.content?.trim();
    if (!text) {
      logger.warn("generator", "AI returned empty response");
      return null;
    }

    // Safe length cap
    const result = text.length > 240 ? text.slice(0, 239) + "…" : text;

    logger.info(
      "generator",
      `[EN] Comment for @${authorHandle}: "${result.slice(0, 50)}..."`,
    );
    return result;
  } catch (err: any) {
    logger.error("generator", `AI error: ${err.message}`);
    return null;
  }
}
