import type { Advice, Option } from "../game/core/botbrain";
import type { Clan } from "../game/core/world";

/**
 * Optional AI advisor (Groq). It never plays the bots: the rule engine lists the targets a bot can really beat, the model only
 * PICKS one and says why, and anything it answers is checked against that list (an invented target is simply ignored).
 * The browser talks to /api/groq, a proxy in vite.config.ts that adds your key on the server side, so the key never reaches the page.
 */
export const ADVISOR_URL = "/api/groq/chat/completions";
export const ADVISOR_MODEL: string =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_GROQ_MODEL ?? "openai/gpt-oss-20b";

export function buildMessages(bot: Clan, options: Option[]) {
  return [
    {
      role: "system",
      content:
        `You are the war council of ${bot.name}, a ${bot.doctrine} warlord in a medieval strategy game. ` +
        'Pick exactly ONE target from the list, the one that best suits your character and the odds. "odds" is your strength divided by theirs (above 1 is safe). ' +
        '"conquer" is only possible when canConquer is true. Reply with JSON only, in this shape: ' +
        '{"target":"<id from the list>","action":"raid"|"conquer","reason":"<at most 18 words, in character>"}',
    },
    {
      role: "user",
      content: JSON.stringify({
        warlord: bot.name,
        style: bot.doctrine,
        options: options.map((o) => ({
          id: o.id,
          who: o.label,
          kind: o.kind,
          distance: o.dist,
          odds: o.ratio,
          loot: o.loot,
          canConquer: o.conquer,
        })),
      }),
    },
  ];
}

/** Turn the model's text into advice, or null. Strict: unknown targets and impossible actions are rejected or corrected. */
export function parseAdvice(text: string, options: Option[]): Advice | null {
  const raw = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let j: { target?: unknown; action?: unknown; reason?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const opt = options.find((o) => o.id === String(j.target));
  if (!opt || !opt.viable) return null;
  const action: Advice["action"] =
    j.action === "conquer" && opt.conquer ? "conquer" : "raid";
  const reason =
    typeof j.reason === "string"
      ? j.reason.replace(/\s+/g, " ").trim().slice(0, 160)
      : "";
  return { targetId: opt.id, action, reason };
}

export async function askAdvisor(
  bot: Clan,
  options: Option[],
  o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Advice | null> {
  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await f(ADVISOR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: ADVISOR_MODEL,
        temperature: 0.7,
        max_tokens: 400,
        messages: buildMessages(bot, options),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseAdvice(
      String(data?.choices?.[0]?.message?.content ?? ""),
      options,
    );
  } finally {
    clearTimeout(timer);
  }
}
