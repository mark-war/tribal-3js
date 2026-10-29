import { planOptions, type TurnCtx } from "../game/core/botbrain";
import { SPEED, worldAgeHours } from "../game/core/economy";
import { protectionLeftHours } from "../game/core/rivals";
import { BOTS, PLAYER, nemesisClan } from "../game/core/world";
import { useGame } from "../game/store";
import { askAdvisor } from "./advisor";

const HOUR = 3_600_000;

/** One advisor round: pick a bot near you that has no plan yet, show the model its real options, store its pick. */
export async function advisorStep(fetchImpl?: typeof fetch): Promise<string> {
  const s = useGame.getState();
  if (!s.aiEnabled || s.rivalMode === "off") return "idle";
  const now = Date.now();
  const owned = Object.values(s.villages).filter((v) => v.owner === PLAYER);
  if (!owned.length) return "idle";
  const ref = owned[0];
  const points = owned.reduce((n, v) => n + v.points, 0);
  const protectedNow = protectionLeftHours(worldAgeHours(now), points) > 0;
  const nem = nemesisClan();
  const ctx: TurnCtx = {
    now,
    world: s.villages,
    owned,
    warOnPlayer: s.rivalMode === "war" && !protectedNow,
    skipPlayer: new Set(
      BOTS.filter(
        (b) => b.id === nem.id || (s.rivals[b.id]?.grudge ?? 0) > 0.05,
      ).map((b) => b.id),
    ),
    held: Object.fromEntries(
      Object.entries(s.rivals).map(([k, r]) => [k, r.held ?? 0]),
    ),
  };
  const fresh = (HOUR * 12) / SPEED; // a plan stays valid for 12 game hours
  const spotlight = BOTS.filter(
    (b) => !s.aiAdvice[b.id] || now - s.aiAdvice[b.id].at > fresh,
  )
    .sort(
      (p, q) =>
        Math.hypot(p.home[0] - ref.x, p.home[1] - ref.y) -
        Math.hypot(q.home[0] - ref.x, q.home[1] - ref.y),
    )
    .slice(0, 10);
  for (const bot of spotlight) {
    const plan = planOptions(bot, ctx);
    const options = (plan?.options ?? [])
      .filter((o) => o.viable)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (options.length < 2) continue; // nothing to decide
    const advice = await askAdvisor(bot, options, { fetchImpl });
    if (!advice) {
      s.setAiStatus(`${bot.name}: no usable answer`);
      return "none";
    }
    s.setAdvice(bot.id, { ...advice, at: now });
    const target = options.find((o) => o.id === advice.targetId)!;
    s.pushNews(
      `🧠 ${bot.name} plans to ${advice.action === "conquer" ? "conquer" : "strike"} ${target.label}${advice.reason ? `: "${advice.reason}"` : ""}`,
    );
    s.setAiStatus(`ok · last: ${bot.name}`);
    return "ok";
  }
  return "idle";
}

/** Runs the advisor every few seconds while the AI switch is on. Any failure leaves the bots on their own rules. */
export function startAdvisor(): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !useGame.getState().aiEnabled) return;
    busy = true;
    try {
      await advisorStep();
    } catch (e) {
      useGame
        .getState()
        .setAiStatus(
          `error: ${(e as Error).message} (the bots use their own rules)`,
        );
    } finally {
      busy = false;
    }
  }, 12_000);
  return () => clearInterval(timer);
}
