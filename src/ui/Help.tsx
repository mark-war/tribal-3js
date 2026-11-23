import { useState } from "react";
import { BUILDINGS } from "../game/config/buildings";
import { UNITS, UNIT_IDS } from "../game/config/units";
import {
  ATTACK_CLASSES,
  BASE_DEFENSE,
  CATS_PER_LEVEL,
  CLASS_ICON,
  CLASS_NAME,
  HERO_ATTACK_PER_LEVEL,
  HERO_XP_CONQUEST,
  HERO_XP_LEVELS,
  HERO_XP_WIN,
  NOBLE_LOYALTY_HIT,
  SMITHY_BONUS,
  SMITHY_DEFENSE_BONUS,
  defenseBonusFor,
  WALL_FLAT,
  WALL_GROWTH,
  RAM_DECAY,
  ramsToBreakWall,
  wallFlat,
  wallMult,
  ramPreLevels,
  attackBonusFor,
  battlePowers,
  catapultLevels,
  defenseRating,
  pips,
  resolveBattle,
  tier,
} from "../game/core/combat";
import {
  MERCHANT_CAPACITY,
  MERCHANT_MIN_PER_FIELD,
  SPEED,
} from "../game/core/economy";
import { BOTS } from "../game/core/world";
import { normalizeUnits } from "../game/core/world";
import type { UnitId, Units } from "../game/core/types";

const TABS = [
  ["combat", "Combat"],
  ["war", "⚔ War Table"],
  ["units", "Units"],
  ["wall", "Walls & siege"],
  ["loyalty", "Loyalty"],
  ["support", "🛡 Support & Market"],
  ["world", "🌍 Rivals"],
  ["reqs", "🌳 Requirements"],
  ["hero", "🦸 Paladin"],
  ["reports", "📜 Reports"],
  ["scout", "Scouting"],
  ["eco", "Buildings & pop."],
  ["sim", "🧪 Simulator"],
] as const;
type Tab = (typeof TABS)[number][0];

const needs = (u: UnitId) =>
  (UNITS[u].requires ?? [])
    .map((r) => `${BUILDINGS[r.building].name} ${r.level}`)
    .join(", ");
const int = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));
const list = (u: Units) =>
  UNIT_IDS.filter((k) => u[k] > 0)
    .map((k) => `${UNITS[k].name} ${u[k]}`)
    .join(", ") || "none";

function Combat() {
  return (
    <>
      <h3>How a battle is decided</h3>
      <ol>
        <li>
          <b>Attack power</b> = sum of (attack × number) of the units you send,
          × (1 + {SMITHY_BONUS * 100}% per Smithy level of the village they left
          from — the village's own Smithy, not the target's) × the Paladin's
          bonus if he marches with them.
        </li>
        <li>
          Every unit attacks as one of three <b>classes</b>: 🗡️ infantry, 🐎
          cavalry or 🏹 ranged. Your army's <b>attack mix</b> is the share of
          its attack power in each class.
        </li>
        <li>
          Every defender has a <b>separate defense value against each class</b>.
          The garrison's defense against a class is{" "}
          <b>
            (its units' values + {BASE_DEFENSE} free + {WALL_FLAT} per wall
            level) × {WALL_GROWTH}
            <sup>wall level</sup>
          </b>
          : the wall multiplies your defenders and also fights on its own. Your
          units' values also get{" "}
          <b>
            +{SMITHY_DEFENSE_BONUS * 100}% per level of the Smithy of the
            village being defended
          </b>
          : the host's Smithy counts for everyone standing there, support
          included (the supporters' own Smithy plays no part).
        </li>
        <li>
          <b>Defense power</b> = those three defenses weighted by the attacker's
          mix. Send the class a village is weakest against and it crumbles; a
          mixed army is safer but wastes its edge.
        </li>
        <li>The higher number wins. The attacker must be strictly higher.</li>
        <li>
          <b>Losses:</b> the winner loses (weaker ÷ stronger)<sup>1.5</sup> of
          its army. A losing defender loses that same fraction, but if the
          attacker wins, <i>all</i> defenders die. Survivors are rounded to the
          nearest whole unit.
        </li>
        <li>
          <b>The wall is a defender:</b> its flat defense counts even with
          nobody home, so attacking a walled village costs troops, and an attack
          too weak to beat the wall dies against it.
        </li>
        <li>
          <b>Loot:</b> survivors carry their 🎒 capacity home, split evenly
          between wood, clay and iron (a share the village can't fill is left
          unused). Rams, Catapults, Scouts and Nobles carry nothing.
        </li>
      </ol>

      <h3>Who counters who?</h3>
      <ul>
        <li>
          🗡️ <b>Infantry</b> attackers (Axemen, Rams, Catapults, Nobles) are
          stopped by Swordsmen, Archers and Heavy Cavalry.
        </li>
        <li>
          🐎 <b>Cavalry</b> attackers (Light and Heavy Cavalry, Paladin) are
          stopped by Spearmen.
        </li>
        <li>
          🏹 <b>Ranged</b> attackers (Archers, Mounted Archers) are stopped by
          Heavy Cavalry, and fairly well by Swordsmen.
        </li>
      </ul>
      <p>
        The Units tab rates every number from 0 to 5 with pips (●●●○○), so you
        can compare units at a glance. Ratings step up at 1, 15, 30, 80 and 140.
      </p>
      <div className="ex">
        <b>Example:</b> 10 Light Cavalry (attack 1300) vs 20 Spearmen: Spearmen
        defend at 45 each against cavalry = 920. Cavalry still win, but lose
        ≈60%. The same 20 Spearmen against 32 Axemen (attack 1280) only defend
        at 15 each = 320, so the Axemen lose just ≈13%.
      </div>

      <h3>Roles</h3>
      <p>
        <b>Defensive</b> (Spearman, Swordsman, Archer) stays home.{" "}
        <b>All-round</b> (Heavy Cavalry, Paladin) is strong both ways, but
        expensive and heavy on population. <b>Offensive</b> (Axeman, Light
        Cavalry, Mounted Archer, Ram, Catapult) is how you hit. <b>Special</b>{" "}
        (Scout, Nobleman) does jobs.
      </p>

      <h3>Who defends who?</h3>
      <p>
        <b>Every unit standing in a village defends it</b>, whatever its role.
        Troops out on a march don't defend anything until they're home again.
        Troops you send as <b>support</b> to another of your villages defend{" "}
        <i>that</i> village (see the Support &amp; Market tab). Sending anything
        out needs a <b>Rally Point</b>.
      </p>

      <h3>Strategy tips</h3>
      <ul>
        <li>
          <b>Scout first.</b> The report shows their defense against each class
          and wall; the target panel then predicts the fight with your chosen
          units.
        </li>
        <li>
          Intel gets old: troops can be trained or return after you scouted.
        </li>
        <li>
          Don't leave one class undefended: a smart enemy will send exactly
          that.
        </li>
      </ul>
    </>
  );
}

function UnitsTab() {
  const cell = (v: number) => (
    <td>
      {v}
      <span className="pips">{pips(tier(v))}</span>
    </td>
  );
  return (
    <>
      <h3>Unit stats</h3>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Role</th>
              <th>As</th>
              <th>⚔</th>
              {ATTACK_CLASSES.map((k) => (
                <th
                  key={k}
                  title={`Defense against ${CLASS_NAME[k]} attackers`}
                >
                  🛡{CLASS_ICON[k]}
                </th>
              ))}
              <th>🎒</th>
              <th>🚶</th>
              <th>👥</th>
              <th>Needs</th>
            </tr>
          </thead>
          <tbody>
            {UNIT_IDS.map((u) => {
              const d = UNITS[u];
              return (
                <tr key={u}>
                  <td>{d.name}</td>
                  <td>{d.role}</td>
                  <td>{CLASS_ICON[d.klass]}</td>
                  {cell(d.attack)}
                  {ATTACK_CLASSES.map((k) => (
                    <td key={k}>
                      {d.defense[k]}
                      <span className="pips">{pips(tier(d.defense[k]))}</span>
                    </td>
                  ))}
                  <td>{d.carry}</td>
                  <td>{d.minutesPerField}</td>
                  <td>{d.pop}</td>
                  <td>{needs(u)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ marginTop: 6 }}>
        ⚔ attack · 🛡🗡️/🐎/🏹 defense against infantry / cavalry / ranged
        attackers · 🎒 loot carried per unit · 🚶 minutes per field (a group
        moves at its slowest unit) · 👥 population. Pips rate each number 0–5.
      </p>
      <p>
        Special roles: <b>Scouts</b> gather intel, <b>Rams</b> break walls,{" "}
        <b>Catapults</b> destroy buildings, <b>Nobles</b> conquer, and the{" "}
        <b>Paladin</b> is your one hero. Scouts, Rams, Catapults and Nobles
        carry no loot.
      </p>
    </>
  );
}

function WallTab() {
  const none = normalizeUnits({});
  const garrison = normalizeUnits({ spear: 10, sword: 10 });
  return (
    <>
      <h3>What a wall does (as in the original game)</h3>
      <p>The wall does two things at once:</p>
      <ul>
        <li>
          It multiplies everything that defends the village by{" "}
          <b>
            {WALL_GROWTH}
            <sup>level</sup>
          </b>
          : level 5 is +20%, level 10 +44%, level 20 +107%.
        </li>
        <li>
          It <b>fights by itself</b>: it adds {WALL_FLAT} flat defense per level
          (on top of the {BASE_DEFENSE} every village has), and that is
          multiplied too. So an{" "}
          <b>empty village with a wall still kills attackers</b>, and an attack
          that is too weak against the wall is wiped out.
        </li>
      </ul>
      <table>
        <thead>
          <tr>
            <th>Wall</th>
            <th>Defenders ×</th>
            <th>Empty village</th>
            <th>10 Spear + 10 Sword (vs infantry)</th>
            <th>Axemen to beat the empty village</th>
          </tr>
        </thead>
        <tbody>
          {[0, 5, 10, 15, 20].map((L) => {
            const e = defenseRating(none, L);
            const g = defenseRating(garrison, L);
            return (
              <tr key={L}>
                <td>{L}</td>
                <td>{wallMult(L).toFixed(2)}</td>
                <td>{Math.round(e.infantry)}</td>
                <td>{Math.round(g.infantry)}</td>
                <td>{Math.floor(e.infantry / UNITS.axe.attack) + 1}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Which units take a wall down?</h3>
      <ul>
        <li>
          <b>Rams</b> work twice. <b>Before the fight</b> they make the wall
          count as a lower level:{" "}
          <b>
            round(rams ÷ 4 × {RAM_DECAY}
            <sup>−wall</sup>)
          </b>{" "}
          levels, but never below <b>half</b> its level (wall 10 can count as 5
          at best, and needs about {ramsToBreakWall(10)} rams). This only lasts
          for the fight. <b>After a won fight</b>, the rams that survived really
          tear the wall down.
        </li>
        <li>
          <b>Rams get weaker against high walls</b> (the {RAM_DECAY}
          <sup>wall</sup> factor): wall 20 needs about {ramsToBreakWall(20)}{" "}
          rams for the full pre-fight effect, wall 5 only about{" "}
          {ramsToBreakWall(5)}.
        </li>
        <li>
          <b>Catapults</b> aimed at "Wall" lower it after a win (
          {CATS_PER_LEVEL} survivors per level), the same way they destroy other
          buildings.
        </li>
        <li>
          <b>Nothing else does.</b> Axemen, cavalry and Nobles never damage a
          wall; they can only out-muscle it. Rams have almost no attack, so
          escort them with real fighters.
        </li>
      </ul>
      <p>
        <small>
          The ram formulas follow a community guide to the classic game; exact
          numbers may differ by world and version.
        </small>
      </p>
      <div className="ex">
        Example: wall 10, no rams → the wall counts fully. With{" "}
        {ramsToBreakWall(10)} rams it counts as level{" "}
        {10 - ramPreLevels(ramsToBreakWall(10), 10)} during the fight.
      </div>
    </>
  );
}

function SupportTab() {
  return (
    <>
      <h3>Support (garrisons)</h3>
      <p>
        Pick one of your own villages on the map (or in the War Table) and send
        troops there as <b>support</b>. When they arrive they <b>stay</b> in
        that village and defend it with everything else standing there; losses
        are shared out evenly.
      </p>
      <ul>
        <li>
          Support troops stay <b>yours</b>: they keep using the farm of the
          village they came from, not the host's.
        </li>
        <li>
          Send them home any time: War Table → <b>Garrisons</b> → ↩ (the host
          village can send them home too). A march that hasn't arrived can be
          recalled in the first 10 game-minutes.
        </li>
        <li>
          <b>After a conquest</b>, the army that took the village stays there as
          recallable support, so the new village is protected until you decide
          otherwise.
        </li>
      </ul>
      <h3>Market</h3>
      <p>
        Build a <b>Market</b> (needs Headquarters 3 and Warehouse 2). Each level
        gives you <b>1 merchant</b>, carrying {MERCHANT_CAPACITY} resources each
        at {MERCHANT_MIN_PER_FIELD} minutes per field.
      </p>
      <ul>
        <li>
          Open <b>🏪 Market</b> in the top bar (or <b>Send resources</b> on one
          of your villages), choose how much of each resource, and send the
          caravan.
        </li>
        <li>
          Merchants are busy until they walk home. They can't be recalled.
        </li>
        <li>
          Resources above the destination's warehouse capacity are <b>lost</b>;
          the screen warns you before you send.
        </li>
      </ul>
    </>
  );
}

function WorldTab() {
  return (
    <>
      <h3>Finding your way</h3>
      <p>
        On the world map the top bar shows the tile under the mouse (🧭) and the
        last tile you clicked (📍). Click any tile to select the village on it,
        and use <b>x | y → Go</b> to jump straight to coordinates. Reports and
        the ranking have a 📍 button too.
      </p>
      <h3>Starting over</h3>
      <p>
        <b>🆕 New game</b> in the top bar erases the saved game and begins again
        from day one (the bots start as newcomers too), with the speed, rivals
        and village name you pick. Your 2D/3D choice and War Table presets are
        kept.
      </p>
      <h3>Who lives on the map</h3>
      <p>
        <b>Barbarians</b> (tan) are weak, in three flavours: spear-heavy (weak
        to infantry), sword-heavy (weak to cavalry) and mixed with archers.
        Scout to find out which. <b>They grow with the world</b>, as in the
        original: the same village has bigger buildings, a taller wall and more
        troops every day. One you have attacked keeps its losses, but wins its
        troops back.
      </p>
      <p>
        <b>{BOTS.length} bots</b> are AI players, each with its own name,
        colour, fighting style and growth rate, spread over the map (the nearest
        is about 36 fields from you). They <b>start as newcomers</b> and play by{" "}
        <b>your rules</b>: every village has real resources and real queues, a
        bot places construction and training orders that cost what yours cost
        and take as long, it needs the same requirements (no Academy before
        Headquarters 20, Smithy 20 and Market 10, no unit without its building)
        and the same farm limit. It saves for its next building before training
        soldiers, keeps its army in step with its economy, and waits when it
        can't afford something. It wants a little more than a typical player has
        by now, and gets what its resources and time allow, so some bots race
        ahead and some lag. Destroy its Stable and it has to pay to build it
        again.
      </p>
      <table>
        <tbody>
          {Object.entries({
            horde: "Horde: lots of Axemen, some cavalry",
            cavalry: "Cavalry: mounted raiders, Spearmen at home",
            turtle: "Turtle: Spearmen, Swordsmen, Archers behind a tall wall",
            balanced: "Balanced: a bit of everything",
            siege: "Siege: Axemen with Rams and Catapults",
          }).map(([k, t]) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>{t}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Bots play like players</h3>
      <p>
        Every game hour a few bots take a turn. A bot looks at what it can reach
        (barbarians, <b>other bots</b>, and, in War mode, <b>you</b>), works out
        what it needs to win, and attacks the best target it can really beat.
        Their attacks are <b>real marches</b>: the army leaves, takes time to
        arrive (you can see the lines on the map), fights with the very same
        battle rules you play by, and the survivors walk home with the loot.
        Troops die, walls fall, and a village is weaker while its army is out.
        If the target changed hands on the way, the army turns back. Before a
        bot attacks anything it <b>scouts it</b> (a real scouting mission,
        scouts duel scouts just like yours) and sizes its army from that report,
        which can be out of date: if you strengthen a village after they looked,
        they can lose their army. A bot learns from its own battles too, and it
        doubles its scouts after a failure. Bots{" "}
        <b>conquer villages with a noble train</b> when they have earned nobles
        (an Academy, the buildings behind it, resources for four nobles): a
        clearing wave, then{" "}
        <b>four waves landing right behind it, one noble in each</b> with a
        small escort, because only one noble works per attack. Without rams a
        bot can't take a walled village, so it only tries when its escort can
        beat the wall on its own. A threatened bot village <b>calls for help</b>
        : its other villages send up to half of their defenders as support, if
        they can arrive before the attack lands (this includes attacks by you),
        and bring them home when the danger has passed. A bot with several
        villages also moves resources between them with real caravans. The{" "}
        <b>📰 World news</b> tab in the ranking tells the story, and{" "}
        <b>🏆 Ranking</b> shows who is leading: you and all {BOTS.length} bots,
        by points, villages, kills, loot or resources sent. Your numbers are
        exact; a bot's kills, looted and sent are an <b>estimate</b> of its
        off-screen life <b>plus every real event</b>.
      </p>
      <h3>Eliminated bots start again</h3>
      <p>
        A bot that loses its last village (☠ in the ranking and the news) sits
        out for about 6 game hours, then{" "}
        <b>starts again as a newcomer on a barbarian village</b> (never within
        20 fields of yours): a fresh village, small army, building up from
        scratch. Its past lives still count in the ranking, but a bot only earns
        while it owns a village.
      </p>
      <h3>Your nemesis 😈</h3>
      <p>
        The bot that lives closest to your first village is your <b>nemesis</b>{" "}
        (red on the map). It develops a little faster, and{" "}
        <b>taking one of its villages gives your Paladin extra xp</b>.
      </p>
      <h3>🛡 Beginner protection</h3>
      <p>
        For your first <b>24 game hours</b> (or until you reach{" "}
        <b>800 points</b>) bots can't attack you, and you can't attack them.
        Barbarians are fair game and scouting is allowed. The top bar shows how
        long is left.
      </p>
      <h3>How hostile are they?</h3>
      <p>
        The <b>rivals selector</b> in the top bar:
      </p>
      <ul>
        <li>
          <b>🚫 Rivals off:</b> the bots do nothing at all, so the world stands
          still. For multiplayer, or to build in peace. Their villages stay as
          ordinary targets.
        </li>
        <li>
          <b>😴 Peaceful:</b> the bots live their own lives (fighting each
          other, conquering) but nobody attacks <i>you</i>.
        </li>
        <li>
          <b>🛡 Hit back only:</b> a bot raids you only after <i>you</i>{" "}
          attacked one of its villages (a grudge). Hitting it harder, or
          conquering a village, makes the grudge bigger. Grudges fade over time.
        </li>
        <li>
          <b>⚔ Raids</b> (default): as above, <i>and</i> your nemesis sends an
          occasional unprovoked raid.
        </li>
        <li>
          <b>👑 War (like players):</b> everything above, and{" "}
          <b>
            any bot in range may raid you or send a noble run to conquer your
            villages
          </b>
          , like a normal player would. Nobody can take your <b>last</b>{" "}
          village.
        </li>
      </ul>
      <p>
        Raids never land while the game is closed: one that falls due while you
        are away launches when you come back, with full warning. All of these
        times stretch with the game speed.
      </p>
      <h3>How bold are they? 🔥</h3>
      <p>
        The <b>bot boldness</b> selector in the top bar changes how risky the
        bots play, never whether they scout first. <b>Calm</b> attacks only with
        a 30% edge, takes a turn about every 14 game hours and one action at a
        time; <b>Normal</b> wants a 15% edge, every 10 hours; <b>Aggressive</b>{" "}
        accepts a 5% edge, every 6 hours, <b>2 attacks at once</b> (from
        different villages) and goes after you more often; <b>Relentless</b>{" "}
        attacks at even odds (luck decides), every 4 hours, 3 actions per turn,
        and always sends noble trains when it can. A bot never sends a second
        army at a village it is already attacking.
      </p>
      <h3>Bot Paladins 🦸</h3>
      <p>
        Every bot has a Paladin too (kept as experience, there is no unit to
        kill). He leads the bot's <b>clearing army</b>: +5% attack per level,
        and the bot counts that bonus when it decides what it can beat. A won
        fight gives him xp (more for a conquest) and the <b>World news</b> tells
        when one levels up. If the army he leads <b>loses, he falls</b> and the
        bot starts over at level 0. Beat the army with the Paladin and you reset
        it.
      </p>
      <h3>When they come for you</h3>
      <ul>
        <li>
          An <b>Incoming attacks</b> panel appears with the time left (raids 🚩
          and noble runs 👑). Their army is unknown, so scout their villages
          beforehand. The panel shows which of your other villages can still
          send support in time, with a <b>Prepare support</b> button.
        </li>
        <li>
          The fight is exactly like any battle, against{" "}
          <b>everyone standing in the village</b>. If the attackers win, every
          defender dies (including support standing there) and raiders carry off
          resources. The <b>Hiding Place</b> keeps some of every resource out of
          reach.
        </li>
        <li>
          <b>Noble trains:</b> they scout you first (you see 🔍 SCOUTS on the
          Incoming panel, and your own scouts at home fight them), then a
          clearing wave comes, and four waves with <b>one noble each</b> land
          right behind it. Each noble that gets through cuts the loyalty by
          20–35; at 0 the village is theirs,{" "}
          <b>and troops you had away from it and marches it sent are lost</b>.{" "}
          <b>Kill the nobles</b> (keep troops home, send support, or snipe a
          wave) and the train fails. Your last village can never be taken.
        </li>
        <li>
          Raiders' villages are <b>weaker while the army is out</b>, they{" "}
          <b>retrain</b> their losses (only in buildings they still have:
          destroy the Stable and that village never trains cavalry again), and
          if you conquer the village a raid came from, its raiders never get
          home.
        </li>
      </ul>
      <h3>🧠 AI advisor (optional)</h3>
      <p>
        With <b>🧠 AI on</b>, a Groq language model advises the bots nearest to
        you. It never plays for them: the game lists the targets a bot can
        really beat, the model <b>picks one and says why</b> (you see it in the
        world news), and anything it answers is checked against that list. If it
        fails or the key is missing, the bots simply use their own rules. Put{" "}
        <code>GROQ_API_KEY=…</code> in <code>.env.local</code> and restart the
        dev server; the key is added by the dev server's proxy and never reaches
        the browser.
      </p>
    </>
  );
}

function ReqsTab() {
  const list = (r?: { building: keyof typeof BUILDINGS; level: number }[]) =>
    r?.length
      ? r.map((x) => `${BUILDINGS[x.building].name} ${x.level}`).join(", ")
      : "—";
  return (
    <>
      <h3>Requirements</h3>
      <p>
        Requirements gate the <i>first</i> construction only. Hover the ⓘ on any
        building or unit to see where you stand.
      </p>
      <h3>Buildings</h3>
      <table>
        <thead>
          <tr>
            <th>Building</th>
            <th>Max</th>
            <th>Needs</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(BUILDINGS) as (keyof typeof BUILDINGS)[]).map((id) => (
            <tr key={id}>
              <td>{BUILDINGS[id].name}</td>
              <td>{BUILDINGS[id].maxLevel}</td>
              <td>{list(BUILDINGS[id].requires)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Units</h3>
      <table>
        <thead>
          <tr>
            <th>Unit</th>
            <th>Needs</th>
          </tr>
        </thead>
        <tbody>
          {UNIT_IDS.map((u) => (
            <tr key={u}>
              <td>{UNITS[u].name}</td>
              <td>{list(UNITS[u].requires)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 6 }}>
        For example: the <b>Academy</b> needs Headquarters 20, Smithy 20 and
        Market 10 (all at or near their maximum), and the <b>Nobleman</b> needs
        those same levels <i>every time you train one</i>, plus 40,000 wood /
        50,000 clay / 50,000 iron, which needs a big Warehouse. These follow the
        original game.
      </p>
    </>
  );
}

function HeroTab() {
  return (
    <>
      <h3>The Paladin</h3>
      <p>
        Build a <b>Statue</b>, then train your <b>Paladin</b>: a single
        all-round hero (you can only ever have one). He is a cavalry unit with{" "}
        {UNITS.paladin.attack} attack, strong defense against every class, and
        carries {UNITS.paladin.carry}.
      </p>
      <ul>
        <li>
          <b>Levels 1–5:</b> he gains {HERO_XP_WIN} xp for every battle won with
          him in the army, and {HERO_XP_CONQUEST} more for conquering a village.
          Level thresholds: {HERO_XP_LEVELS.join(", ")} xp.
        </li>
        <li>
          <b>Bonus:</b> +{HERO_ATTACK_PER_LEVEL * 100}% attack per level to the
          army he marches with, on top of your Smithy bonus. At level 5 that is
          +{HERO_ATTACK_PER_LEVEL * 500}%.
        </li>
        <li>
          He <b>survives every battle you win</b>. If the army loses, he can
          fall, and you'd have to train him again (his xp is kept).
        </li>
        <li>
          He uses {UNITS.paladin.pop} population, so he leaves your Farm with
          less room for troops.
        </li>
      </ul>
      <p>
        Defending bonuses and support are not active yet, because nobody can
        attack you in this version.
      </p>
    </>
  );
}

function WarTab() {
  return (
    <>
      <h3>The War Table</h3>
      <p>
        Open it from the top bar, or from the target panel. It plans an{" "}
        <b>operation</b>: one or more <b>waves</b>, each with its own troops and
        landing time.
      </p>
      <ol>
        <li>
          <b>Pick a target</b> on the world map, or type its coordinates.
        </li>
        <li>
          <b>Add troops to a wave</b>, or click a preset: ⚔ Strike (all
          offense), 🐎 Raid (fast loot), 🔍 Scout ×3, or 👑 Noble train. You can
          save your own with ⭐.
        </li>
        <li>
          <b>Set the landing time:</b> earliest possible, or an exact clock
          time. Each wave lands at its own offset in seconds (e.g. rams at +0,
          nobles at +0.5s, +0.8s…), so the departure times are worked out for
          you.
        </li>
        <li>
          <b>Read the checks:</b> travel time, arrival time, loot capacity, your
          home defense after the troops leave, and a prediction from your last
          scout report for each wave and the whole operation.
        </li>
        <li>
          <b>Commit.</b> Troops leave for the road immediately (they no longer
          defend home).
        </li>
      </ol>
      <div className="ex">
        <b>Noble train:</b> the first wave kills the defenders and smashes the
        wall; nobles land right behind it, one per wave, each cutting 20–35
        loyalty. Landing them apart means the defenders are already dead when
        they arrive.
      </div>
      <p>
        <b>Recall:</b> a march can be called back during the first 10
        game-minutes after it departs; the troops turn around where they are.
        Troops that haven't left yet just stay home.
      </p>
      <p>
        The map draws a dashed line to your target and a line for each army
        marching.
      </p>
    </>
  );
}

function LoyaltyTab() {
  return (
    <>
      <h3>Conquering a village</h3>
      <p>
        Only <b>Noblemen</b> can conquer (they need an Academy). Every village
        has <b>loyalty 0–100</b>.
      </p>
      <ol>
        <li>
          Your army must first <b>win the battle</b>. If it loses, the nobles
          die with it.
        </li>
        <li>
          <b>One noble works per attack</b> and lowers loyalty by <b>20–35</b>{" "}
          (average {NOBLE_LOYALTY_HIT}, fixed for that attack). The others in
          the same attack are wasted effort: they come home alive. So a
          full-loyalty village needs{" "}
          <b>3 to 5 attacks, each with its own noble</b>: that is a{" "}
          <b>noble train</b>, which the War Table builds for you. The noble is
          used up either way.
        </li>
        <li>
          At <b>0 or below</b> the village becomes yours. Loyalty is set to 25,
          its queues are cleared, and your surviving troops stay as its
          garrison. No loot is taken.
        </li>
        <li>
          Loyalty slowly climbs back toward 100 (+1 per hour at normal speed, +
          {SPEED} per hour at the current game speed), so follow-up attacks
          should come quickly.
        </li>
      </ol>
      <div className="ex">
        Nobles cost <b>{UNITS.noble.pop} population</b> each, so you need a big
        Farm. Send them together with enough troops to win the battle.
      </div>
    </>
  );
}

function ReportsTab() {
  return (
    <>
      <h3>Reading reports</h3>
      <p>
        Every report has a <b>one-line summary</b> in the Reports tab.{" "}
        <b>Click it</b> (or the pop-up that appears when a fight ends) to open
        the full report.
      </p>
      <h3>Battle report</h3>
      <ul>
        <li>
          <b>Both armies:</b> what was sent or stood at home, what was lost and
          what is left.
        </li>
        <li>
          <b>How it was decided:</b> your attack power and mix, their defense
          against each class, the wall (before the rams, after the rams, after
          the fight), and how big your losses were and why.
        </li>
        <li>
          <b>Spoils and effects:</b> loot against your carrying capacity,
          loyalty, buildings hit by catapults, and your Paladin's xp.
        </li>
      </ul>
      <div className="ex">
        <b>Fog of war:</b> if your whole army dies, none of it comes back to
        tell the tale, so you learn <i>nothing</i> about the defenders (not even
        their numbers). Scout first, so a failed attack still leaves you with
        intel.
      </div>
      <p>
        Villages in a report have a <b>📍</b> button: it closes the report,
        switches to the world map and slides the camera to that village.
      </p>
      <h3>Scouting report</h3>
      <p>
        A scouting report shows more or less depending on how many of your
        scouts survived their scouts: Glimpse (resources, loyalty), Recon (+
        troops, wall, defense) or Full report (+ buildings). It's a snapshot: it
        ages.
      </p>
      <p>Reports saved before this update only keep their summary line.</p>
    </>
  );
}

function ScoutTab() {
  return (
    <>
      <h3>Scouting</h3>
      <p>
        Use the <b>Scout</b> button (it sends only Scouts). Scouts don't fight
        armies, but they <b>duel the village's own scouts</b>:
      </p>
      <ul>
        <li>
          Every defending scout kills about 0.6 of yours; every scout you send
          kills about 0.4 of theirs. <b>Both sides lose scouts</b>, so a big
          scouting wave thins their scouts for the next one.
        </li>
        <li>
          What you <b>see</b> depends on how many of your scouts <i>survive</i>{" "}
          compared with theirs:
          <ul>
            <li>
              <b>None survive:</b> you learn nothing.
            </li>
            <li>
              <b>🔍 Glimpse:</b> any survivor — resources and loyalty.
            </li>
            <li>
              <b>🔍 Recon:</b> survivors ≥ half their scouts — also troops, wall
              and their defense against each class.
            </li>
            <li>
              <b>🔍 Full report:</b> survivors ≥ their scouts — also every
              building level.
            </li>
          </ul>
        </li>
        <li>
          Rule of thumb: send about <b>1.6× their scout count</b> for a Full
          report. Barbarian villages have no scouts, so you always get
          everything.
        </li>
      </ul>
      <p>
        The target panel only shows predictions once you have Recon or better. A
        newer report replaces the older one, and intel gets old: troops can be
        trained or return after you scouted.
      </p>
      <p>
        Scouts sent with an <i>Attack</i> fight like any other unit (attack 0),
        so they die if the army loses.
      </p>
    </>
  );
}

function EcoTab() {
  return (
    <>
      <h3>Population</h3>
      <p>
        Every unit uses population (👥): at home, in training, or away on a
        march. The Farm sets the cap, and you can't train past it.
      </p>
      <h3>Which building does what</h3>
      <table>
        <tbody>
          {(Object.keys(BUILDINGS) as (keyof typeof BUILDINGS)[]).map((id) => (
            <tr key={id}>
              <td>
                <b>{BUILDINGS[id].name}</b>
              </td>
              <td>{BUILDINGS[id].desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Luck 🍀</h3>
      <p>
        With <b>luck on</b> (a New game option), every attack counts for{" "}
        <b>75%–125%</b> of its strength. The luck is fixed for that attack
        (reloading changes nothing) and shown in the report. The simulator has a
        Luck box to try bad and good luck, and every report has a{" "}
        <b>🧪 Open in the simulator</b> button that loads both armies, the wall,
        the smithies and the luck of that fight. Bots' attacks get luck too, so
        a bot sized exactly to your defense can still lose, or win more than it
        should.
      </p>
      <h3>Morale 😓 and the night bonus 🌙</h3>
      <p>
        <b>Morale</b> protects small players: an attack on a player (or bot)
        with far fewer points than the attacker counts for less than its full
        strength, down to a floor of 30% that rises to 50% as the world ages. It
        is 100% when the defender is as big as you or bigger, never a bonus, and
        never applies to barbarian villages. The exact formula isn't published,
        so this one is an approximation: 0.3 + defender points ÷ attacker
        points. Both are the total points of all of a player's villages.{" "}
        <b>Night bonus:</b> while it is night on the world clock (0:00–8:00,
        shown in the top bar, game time: at ×60 a whole day takes 24 real
        minutes), defenders fight with <b>double strength</b>, the wall
        included, when the attack <i>lands</i>. Time your waves for the day. It
        doesn't apply to barbarians or scouts. Both can be switched off in New
        game; reports say when they counted, the war table's prediction includes
        them, and bots count them when they decide what they can beat.
      </p>
      <h3>War Table presets</h3>
      <p>
        The presets (Strike, Raid, Scout, Garrison, Noble train) are ordinary
        presets: click one to load it, then{" "}
        <b>change the waves, rename it and 💾 Update</b>, delete it, or save the
        waves as a new one. <b>∞</b> next to a unit means "all I have", so the
        preset stays up to date as your army grows (a fixed number stays fixed).
        Fixed numbers are given out first, so the noble train's escorts are
        protected and the clearing wave takes what is left; if you have fewer
        nobles than waves, the extra noble waves drop out.
      </p>
      <h3>Cancelling</h3>
      <p>
        Every construction and training order has a <b>✕</b>: it gives back{" "}
        <b>90%</b> of what it cost (cancelling a construction also cancels later
        upgrades of the same building, since they depend on it, and the orders
        behind it move up). A march has <b>↩ Cancel</b> while it is still
        allowed: the troops turn around where they are (during the first 10 game
        minutes after they leave; a wave that has not left yet simply stays
        home). Caravans can't be cancelled.
      </p>
      <h3>Times and costs</h3>
      <p>
        Unit <b>stats, costs, speeds and population</b> are the original game's
        table. <b>Construction time</b> = base × 1.18 × 1.2<sup>e</sup> × 1.05
        <sup>−Headquarters</sup> (levels 1–2 are quick, later levels get much
        longer), and <b>training time</b> = ⅔ × base × 1.06
        <sup>−building level</sup>, the original formulas; the whole game then
        runs {SPEED}× faster (change it with the ⏱ selector in the top bar;{" "}
        <b>Real time</b> is ×1, where Headquarters level 1 takes about 100
        seconds and a Spearman about 11 minutes). Base times are the real ones
        for units and for the Headquarters, Warehouse, Hiding Place and Wall;
        for the other buildings they are still my estimates.
      </p>
      <p style={{ marginTop: 6 }}>
        Requirements only block the <i>first</i> construction. Hover any ⓘ for
        exact requirements, costs and times. Training speed depends on the
        building that trains the unit (Barracks, Stable, Workshop or Academy).
      </p>
    </>
  );
}

/** What a report hands to the simulator: both armies, the wall and the smithies. */
export interface SimSeed {
  a: Partial<Units>;
  d: Partial<Units>;
  wall: number;
  smithy: number;
  defSmithy: number;
  heroLvl: number;
  luck?: number;
  morale?: number;
  night?: boolean;
  note?: string;
} // luck: a fraction, +0.12 = +12%; morale 0.3..1

function Sim({ seed }: { seed?: SimSeed | null }) {
  const [a, setA] = useState<Partial<Units>>(seed?.a ?? { axe: 20, ram: 4 });
  const [d, setD] = useState<Partial<Units>>(
    seed?.d ?? { spear: 10, sword: 5 },
  );
  const [wall, setWall] = useState(seed?.wall ?? 5);
  const [smithy, setSmithy] = useState(seed?.smithy ?? 0);
  const [heroLvl, setHeroLvl] = useState(seed?.heroLvl || 1);
  const [defSmithy, setDefSmithy] = useState(seed?.defSmithy ?? 0);
  const [luckPct, setLuckPct] = useState(Math.round((seed?.luck ?? 0) * 100)); // luck: -25..+25 (% of the attack)
  const att = normalizeUnits(a);
  const def = normalizeUnits(d);
  const [moralePct, setMoralePct] = useState(
    Math.round((seed?.morale ?? 1) * 100),
  ); // morale: 30..100 (% of the attack)
  const [night, setNight] = useState(!!seed?.night); // night bonus: the defense counts double
  const bonus =
    attackBonusFor(smithy, att, heroLvl) *
    (1 + luckPct / 100) *
    (moralePct / 100);
  const dm = night ? 2 : 1;
  const p = battlePowers(att, def, wall, bonus, defenseBonusFor(defSmithy), dm);
  const r = resolveBattle(
    att,
    def,
    wall,
    bonus,
    defenseBonusFor(defSmithy),
    dm,
  );
  const nobles = r.attackerWins ? r.attackerLeft.noble : 0;
  const cats = r.attackerWins ? catapultLevels(r.attackerLeft.catapult) : 0;
  return (
    <>
      <p>
        Try any battle. Nothing here touches your game.
        {seed?.note && (
          <>
            {" "}
            <b>{seed.note}</b>
          </>
        )}
      </p>
      <table>
        <thead>
          <tr>
            <th>Unit</th>
            <th>Attacker</th>
            <th>Defender</th>
          </tr>
        </thead>
        <tbody>
          {UNIT_IDS.map((u) => (
            <tr key={u}>
              <td>{UNITS[u].name}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  style={{ width: 64 }}
                  value={a[u] ?? 0}
                  onChange={(e) => setA({ ...a, [u]: int(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  style={{ width: 64 }}
                  value={d[u] ?? 0}
                  onChange={(e) => setD({ ...d, [u]: int(e.target.value) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ justifyContent: "flex-start", gap: 14 }}>
        <label>
          Wall{" "}
          <input
            type="number"
            min={0}
            max={20}
            style={{ width: 52 }}
            value={wall}
            onChange={(e) => setWall(Math.min(20, int(e.target.value)))}
          />
        </label>
        <label>
          Attacker's Smithy{" "}
          <input
            type="number"
            min={0}
            max={20}
            style={{ width: 52 }}
            value={smithy}
            onChange={(e) => setSmithy(Math.min(20, int(e.target.value)))}
          />
        </label>
        <label>
          Defender's Smithy{" "}
          <input
            type="number"
            min={0}
            max={20}
            style={{ width: 52 }}
            value={defSmithy}
            onChange={(e) => setDefSmithy(Math.min(20, int(e.target.value)))}
          />
        </label>
        <label title="Morale: an attack on a much smaller player counts for less (30%–100%).">
          😓 Morale %{" "}
          <input
            type="number"
            min={30}
            max={100}
            style={{ width: 52 }}
            value={moralePct}
            onChange={(e) =>
              setMoralePct(
                Math.max(
                  30,
                  Math.min(100, Math.round(Number(e.target.value) || 100)),
                ),
              )
            }
          />
        </label>
        <label title="Night bonus: defenders fight with double strength while it is night in the world (0:00–8:00), never against barbarians.">
          <input
            type="checkbox"
            checked={night}
            onChange={(e) => setNight(e.target.checked)}
          />{" "}
          🌙 Night
        </label>
        <label title="Luck changes how strong the attack counts: −25% to +25%. Every real attack gets its own random luck.">
          🍀 Luck %{" "}
          <input
            type="number"
            min={-25}
            max={25}
            style={{ width: 52 }}
            value={luckPct}
            onChange={(e) =>
              setLuckPct(
                Math.max(
                  -25,
                  Math.min(25, Math.round(Number(e.target.value) || 0)),
                ),
              )
            }
          />
        </label>
        <label>
          Paladin level{" "}
          <input
            type="number"
            min={1}
            max={5}
            style={{ width: 52 }}
            value={heroLvl}
            onChange={(e) =>
              setHeroLvl(Math.max(1, Math.min(5, int(e.target.value))))
            }
          />
        </label>
      </div>
      <div className="ex">
        <div>
          ⚔ Attack power <b>{Math.round(p.a)}</b> &nbsp; 🛡 Defense power{" "}
          <b>{Math.round(p.d)}</b> <small>(wall after rams: {p.effWall})</small>
        </div>
        <div>
          <small>
            Attack mix:{" "}
            {ATTACK_CLASSES.filter((k) => p.shares[k] > 0.005)
              .map((k) => `${CLASS_ICON[k]} ${Math.round(p.shares[k] * 100)}%`)
              .join("  ")}{" "}
            · Their defense:{" "}
            {ATTACK_CLASSES.map(
              (k) => `${CLASS_ICON[k]}${Math.round(p.rating[k])}`,
            ).join("  ")}
          </small>
        </div>
        <div>
          <b className={r.attackerWins ? "green" : "red"}>
            {r.attackerWins ? "Attacker wins" : "Defender wins"}
          </b>
        </div>
        <div>Attackers left: {list(r.attackerLeft)}</div>
        <div>Defenders left: {list(r.defenderLeft)}</div>
        <div>Wall afterwards: {r.wallAfter}</div>
        {r.attackerWins && nobles > 0 && (
          <div>
            👑 One noble works per attack: loyalty −20…35 (average{" "}
            {NOBLE_LOYALTY_HIT})
            {nobles > 1 && ` · the other ${nobles - 1} would come home`}
          </div>
        )}
        {cats > 0 && <div>🏚 Chosen building −{cats} level(s)</div>}
      </div>
    </>
  );
}

export default function Help({
  onClose,
  seed,
}: {
  onClose: () => void;
  seed?: SimSeed | null;
}) {
  const [tab, setTab] = useState<Tab>(seed ? "sim" : "combat");
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <b style={{ fontSize: 16 }}>How the game works</b>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="tabs wrap">
          {TABS.map(([k, l]) => (
            <button
              key={k}
              className={k === tab ? "on" : ""}
              onClick={() => setTab(k)}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === "combat" && <Combat />}
        {tab === "war" && <WarTab />}
        {tab === "units" && <UnitsTab />}
        {tab === "wall" && <WallTab />}
        {tab === "loyalty" && <LoyaltyTab />}
        {tab === "support" && <SupportTab />}
        {tab === "world" && <WorldTab />}
        {tab === "reqs" && <ReqsTab />}
        {tab === "hero" && <HeroTab />}
        {tab === "reports" && <ReportsTab />}
        {tab === "scout" && <ScoutTab />}
        {tab === "eco" && <EcoTab />}
        {tab === "sim" && <Sim seed={seed} />}
      </div>
    </div>
  );
}
