// core/botdebug.ts
// A temporary window into the bots' minds. While BOT_DEBUG is true, every 20 real seconds the console shows, for ONE big bot
// (at least DEBUG_MIN_VILLAGES villages) and for your NEMESIS, a VERDICT line saying which gate stops it from conquering a
// barbarian village, followed by the details. Switch it off (false) or delete this file and its two lines in botbrain.ts.
import { RES, capacity } from "./economy";
import {
  NOBLES_PER_RUN,
  botCanNoble,
  botNobleCost,
  nobleTrain,
} from "./botwar";
import { barbReach, freeBarbarians } from "./botexpand";
import { botVillages, nemesisClan, type Clan } from "./world";
import type { Option, TurnCtx } from "./botbrain";
import type { Village } from "./types";

export const BOT_DEBUG = true;
const DEBUG_MIN_VILLAGES = 10;
const last = new Map<string, number>();
let bigBot: string | null = null; // follow one big bot, so the lines can be compared over time

export function debugBot(
  bot: Clan,
  ctx: TurnCtx,
  plan: { src: Village; options: Option[] } | null,
  maxHoldings: number,
) {
  if (!BOT_DEBUG) return;
  const mine = botVillages(bot, ctx.world, ctx.now);
  const isNemesis = bot.id === nemesisClan().id;
  const isBig =
    mine.length >= DEBUG_MIN_VILLAGES && (!bigBot || bigBot === bot.id);
  if (!isNemesis && !isBig) return;
  if (ctx.now - (last.get(bot.id) ?? 0) < 20_000) return;
  last.set(bot.id, ctx.now);
  if (isBig && !isNemesis) bigBot = bot.id;

  const src = plan?.src;
  const need = Object.fromEntries(
    RES.map((r) => [r, (NOBLES_PER_RUN - 1) * botNobleCost(r)]),
  );
  const cap = src ? capacity(src) : 0;
  const opts = plan?.options ?? [];
  const barb = opts.filter((o) => o.kind === "barbarian");
  const count = (f: (o: Option) => boolean) => opts.filter(f).length;
  const reach = barbReach(mine.length);
  const nearestFree = src
    ? freeBarbarians([src.x, src.y], ctx.world, ctx.now, 400, 1)[0]
    : undefined;
  const freeInReach = src
    ? freeBarbarians([src.x, src.y], ctx.world, ctx.now, reach, 50).length
    : 0;
  const canNoble = src ? botCanNoble(src) : false;
  const trainOk = src ? nobleTrain(src, "debug") >= NOBLES_PER_RUN - 1 : false;
  const held = ctx.held[bot.id] ?? 0;
  const scoutsAll = mine.reduce((n, v) => n + v.units.scout, 0); // in all its villages together

  // the first gate that fails, in the order a conquest needs them
  let verdict: string;
  if (!plan) verdict = "it has no village left";
  else if (!freeInReach)
    verdict = nearestFree
      ? `NO free barbarian village within ${Math.round(reach)} fields of ${src!.id}; the nearest is ${Math.round(Math.hypot(nearestFree.x - src!.x, nearestFree.y - src!.y))} fields away`
      : `NO free barbarian village left near ${src!.id}`;
  else if (!barb.length)
    verdict =
      "free villages exist but none became an option (the search or the exclude list)";
  else if (barb.every((o) => !o.known) && scoutsAll < 2)
    verdict = `NO scouts in any of its ${mine.length} villages (${scoutsAll}): it cannot look at anything, so it never attacks. Its villages are not training them`;
  else if (barb.every((o) => !o.known))
    verdict = barb.every((o) => o.stuck)
      ? `every barbarian target is stuck (cooldown after failed looks, or too strong by points, or scouts failing); scouts there: ${src!.units.scout}`
      : "waiting for scouting reports on the barbarians";
  else if (!barb.some((o) => o.viable))
    verdict = `barbarians scouted but too strong for its army (best ratio ${Math.max(...barb.map((o) => o.ratio))}, it needs at least its margin)`;
  else if (held >= maxHoldings)
    verdict = `conquest cap reached (${held}/${maxHoldings})`;
  else if (!canNoble)
    verdict = `winnable, but ${src!.id} cannot send nobles (no Academy and not Headquarters 10 + Barracks 5)`;
  else if (!trainOk)
    verdict = `winnable, but it cannot pay for ${NOBLES_PER_RUN - 1} nobles yet (warehouse ${cap}, needs ${JSON.stringify(need)})`;
  else if (!barb.some((o) => o.conquer))
    verdict =
      "winnable and nobles ready, but its army is too weak to also protect a noble train (conquest margin)";
  else
    verdict =
      "OK: it can conquer a barbarian village now (if it still does not, the escort check in oneAction is rejecting it)";

  console.log(
    `[bot ${bot.name}${isNemesis ? " (NEMESIS)" : ""}] ${mine.length} villages: ${verdict}`,
  );
  console.log({
    attackFrom: src?.id,
    scoutsThere: src?.units.scout,
    scoutsInAllVillages: scoutsAll,
    canSendNobles: canNoble,
    noblesWeCanPayFor: src ? nobleTrain(src, "debug") : 0,
    noblesNeeded: NOBLES_PER_RUN - 1,
    costOfThatTrain: need,
    warehouseCapacity: cap,
    resourcesThere: src
      ? Object.fromEntries(RES.map((r) => [r, Math.round(src.resources[r])]))
      : null,
    conquestsSoFar: held,
    conquestCap: maxHoldings,
    freeBarbarianVillagesInReach: freeInReach,
    reachFields: Math.round(reach),
    options: {
      barbarian: barb.length,
      bot: count((o) => o.kind === "bot"),
      player: count((o) => o.kind === "player"),
      withReport: count((o) => o.known),
      noReport: count((o) => !o.known),
      stuck: count((o) => !!o.stuck),
      winnable: count((o) => o.viable),
      conquerable: count((o) => o.conquer),
    },
  });
  console.table(
    [...opts]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        owner: o.owner,
        known: o.known,
        stuck: !!o.stuck,
        winnable: o.viable,
        conquer: o.conquer,
        ratio: o.ratio,
        dist: o.dist,
        score: Math.round(o.score),
      })),
  );
}
