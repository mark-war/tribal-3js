export type Resource = "wood" | "clay" | "iron";
export type Cost = Record<Resource, number>;
export type BuildingId =
  | "main"
  | "barracks"
  | "academy"
  | "farm"
  | "stable"
  | "smithy"
  | "rally"
  | "workshop"
  | "statue"
  | "market"
  | "hiding"
  | "timber"
  | "clay"
  | "iron"
  | "warehouse"
  | "wall";
export type UnitId =
  | "spear"
  | "sword"
  | "axe"
  | "archer"
  | "scout"
  | "light"
  | "mounted"
  | "heavy"
  | "ram"
  | "catapult"
  | "paladin"
  | "noble";
export type Units = Record<UnitId, number>;

export interface BuildJob {
  building: BuildingId;
  level: number;
  finishesAt: number;
}
export interface RecruitJob {
  unit: UnitId;
  count: number;
  finishesAt: number;
}

export interface Village {
  id: string;
  name: string;
  x: number;
  y: number;
  owner: string | null; // null = barbarian
  points: number;
  loyalty: number; // 0..100. Nobles lower it; at 0 the village is conquered
  resources: Cost;
  updatedAt: number;
  buildings: Record<BuildingId, number>;
  buildQueue: BuildJob[];
  recruitQueue: RecruitJob[];
  units: Units;
  goal?: Units; // rivals: the garrison they train back up to
  stationed: Record<string, Units>; // support: troops of OTHER villages standing here, keyed by their home village id
  razed?: Partial<Record<BuildingId, boolean>>; // buildings a siege reduced to 0: bots never rebuild these
}

export interface Command {
  id: string;
  kind:
    | "attack"
    | "scout"
    | "support"
    | "trade"
    | "raid"
    | "expand"
    | "strike"
    | "return"
    | "botwar";
  fromId: string;
  toId: string;
  fromXY: [number, number];
  toXY: [number, number];
  units: Units;
  loot: Cost;
  departAt: number;
  arriveAt: number;
  catTarget?: BuildingId; // building the catapults aim at
  expectOwner?: string; // strikes: who owned the target at launch ('' = barbarians); if it changed, the march turns back
  clan?: string; // raids: the rival clan sending them
  merchants?: number; // trade caravans: merchants on the road (they are busy until they are back)
  smithy?: number; // origin Smithy level at send time (attack bonus)
}

export interface BattleDetail {
  kind: "battle";
  perspective: "attack" | "defense"; // 'defense' is for when rivals can attack you
  outcome: "win" | "loss" | "conquered";
  attacker: {
    village: string;
    xy: [number, number];
    sent: Units;
    left: Units;
    bonus: number;
    heroLevel: number;
  };
  /** known=false: your whole army died, so you learned nothing about the defenders. */
  defender: {
    village: string;
    xy: [number, number];
    known: boolean;
    before?: Units;
    left?: Units;
    bonus?: number;
  };
  powers: {
    attack: number;
    defense?: number;
    effWall: number;
    shares: Record<AttackClass, number>;
    rating?: Record<AttackClass, number>;
    killShare?: number;
  };
  wall: { before?: number; after?: number; rams: number };
  loot: Cost;
  carry: number;
  loyalty?: { before: number; after: number; nobles: number };
  siege?: { building: BuildingId; before: number; after: number };
  hero?: { xp: number; levelUp?: number; fell?: boolean };
  luck?: number; // the attacker's luck for this march, from -0.25 to +0.25
}
export interface ScoutDetail {
  kind: "scout";
  village: string;
  xy: [number, number];
  sent: number;
  lost: number;
  success: boolean;
  tier?: 1 | 2 | 3;
  enemyScouts?: number;
  enemyLost?: number; // how much you saw, and the scout duel
  units?: Units;
  resources?: Cost;
  buildings?: Record<BuildingId, number>;
  wall?: number;
  loyalty?: number;
  rating?: Record<AttackClass, number>;
}
export type ReportDetail = BattleDetail | ScoutDetail;
/** `text` is the one-line summary; `detail` (absent on old reports) powers the full report view. */
export interface Report {
  id: string;
  at: number;
  text: string;
  detail?: ReportDetail;
}

/** How a unit ATTACKS. Defenders have a separate defense value against each class. */
export type AttackClass = "infantry" | "cavalry" | "ranged";
export type UnitRole = "offense" | "defense" | "hybrid" | "special";

/** What a successful scout learned. Ages: the village may have changed since `at`. */
export interface Intel {
  at: number;
  tier: 1 | 2 | 3;
  loyalty: number;
  resources: Cost;
  units?: Units;
  wall?: number;
  buildings?: Record<BuildingId, number>;
  enemyScouts?: number;
  smithy?: number;
}

/** One wave of a planned operation (what the War Table edits and saves as a preset). */
export interface WaveDraft {
  kind: "attack" | "scout" | "support";
  units: Partial<Units>;
  offset: number;
  cat: BuildingId;
}
export interface Preset {
  id: string;
  name: string;
  waves: WaveDraft[];
}
/** A wave ready to be committed: lands exactly at `arriveAt`. */
export interface PlanOrder {
  kind: "attack" | "scout" | "support";
  units: Units;
  catTarget?: BuildingId;
  arriveAt: number;
}
