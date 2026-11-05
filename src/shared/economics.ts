import { ClientSession, Types } from 'mongoose';
import { LedgerEntry, LedgerEntryDoc } from '../app/modules/ledger/ledgerEntry.model';

/**
 * A member's value = their contributed principal + their share of fund profit.
 * Profit is split by money actually paid (paid-up members only), NOT by committed shares.
 * So a member who paid ৳0 gets ৳0 profit; whoever paid more earns proportionally more.
 *
 *   profit        = totalAssets − totalContributed   (0 until an investment returns a gain)
 *   myProfitShare = (myContributed ÷ totalContributed) × profit
 *   myValue       = myContributed + myProfitShare
 */
export function memberValue(
  myContributed: number,
  totalContributed: number,
  totalAssets: number,
): { value: number; profitShare: number } {
  const profit = totalAssets - totalContributed;
  const profitShare = totalContributed > 0 ? Math.round((myContributed / totalContributed) * profit) : 0;
  return { value: myContributed + profitShare, profitShare };
}

/** Sum of everyone's paid-in principal for a fund (CASH_IN + imported OPENING_CONTRIBUTION). */
export async function fundContributed(fundId: Types.ObjectId | string, session?: ClientSession): Promise<number> {
  const agg = LedgerEntry.aggregate<{ total: number }>([
    { $match: { fundId: new Types.ObjectId(fundId), kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  if (session) agg.session(session);
  const res = await agg;
  return res[0]?.total ?? 0;
}

export interface MemberPosition {
  contributed: number; // cash this member paid in (net of reversals), incl. any buy-in premium
  value: number; // contributed principal + allocated profit
  profitShare: number; // value − contributed
}

const CASH_KINDS = new Set(['CASH_IN', 'CASH_OUT_INVEST', 'INVEST_RETURN', 'REVERSAL', 'OPENING_CASH']);

/**
 * Every member's position in a fund, with buy-ins handled fairly.
 *
 * A buy-in at NAV pays principal (shares × cycles × faceValue) plus a premium
 * (shares × profitPerShare) — the buyer is purchasing a slice of profit that already exists.
 * The plain memberValue() split would let the buyer ALSO share that pre-existing profit by
 * their full payment, diluting everyone who earned it. So the residual profit is split in
 * segments, cut at each buy-in (a BUYIN_PREMIUM marker):
 *
 *   residual R(t)   = assets(t) − contributed(t)        (premiums cancel: they're in both)
 *   segment k       = R accrued before buy-in k (telescoping, so Σ segments = R(now))
 *   eligible in k   = everyone except members who joined via buy-in k or later; a member's
 *                     extra-share buy-ins at k or later don't count toward their weight in k
 *   weight          = principal (cash paid − premiums), as memberValue() — arrears payers
 *                     still catch up on profit, same as before
 *   buyer's premium → allocated to the buyer (it's what they paid for)
 *
 * With no buy-ins this is exactly memberValue() for everyone.
 */
export type PositionEntry = Pick<
  LedgerEntryDoc,
  '_id' | 'kind' | 'amount' | 'membershipId' | 'refId' | 'reversalOf' | 'at'
>;

/** The ledger rows fundMemberPositions needs, oldest first. */
export async function loadPositionEntries(
  fundId: Types.ObjectId | string,
  session?: ClientSession,
): Promise<PositionEntry[]> {
  const q = LedgerEntry.find(
    {
      fundId: new Types.ObjectId(fundId),
      kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION', 'REVERSAL', 'BUYIN_PREMIUM', 'CASH_OUT_INVEST', 'INVEST_RETURN', 'OPENING_CASH'] },
    },
    { kind: 1, amount: 1, membershipId: 1, refId: 1, reversalOf: 1, at: 1 },
  )
    .sort({ at: 1, _id: 1 })
    .lean<PositionEntry[]>();
  if (session) q.session(session);
  return q;
}

export async function fundMemberPositions(
  fundId: Types.ObjectId | string,
  totalAssets: number,
  session?: ClientSession,
): Promise<Map<string, MemberPosition>> {
  return computeMemberPositions(await loadPositionEntries(fundId, session), totalAssets);
}

/**
 * Entries as the books stood at `asOf`. A BUYIN_PREMIUM counts from its buy-in's CASH_IN time,
 * so a premium recorded after the fact (a correction) doesn't show a phantom profit blip.
 */
export function entriesAsOf(entries: PositionEntry[], asOf: Date): PositionEntry[] {
  const t = asOf.getTime();
  const cashInAt = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'CASH_IN') continue;
    cashInAt.set(String(e._id), e.at.getTime());
    if (e.refId) cashInAt.set(String(e.refId), e.at.getTime());
  }
  return entries.filter((e) => {
    if (e.kind === 'BUYIN_PREMIUM' && e.refId) return (cashInAt.get(String(e.refId)) ?? e.at.getTime()) <= t;
    return e.at.getTime() <= t;
  });
}

/** Pure core of fundMemberPositions — see its doc. `entries` must be oldest first. */
export function computeMemberPositions(entries: PositionEntry[], totalAssets: number): Map<string, MemberPosition> {
  const kindById = new Map(entries.map((e) => [String(e._id), e.kind]));
  const investCost = new Map<string, number>(); // investmentId → cost, from CASH_OUT_INVEST

  const contributed = new Map<string, number>(); // gross cash paid per member
  const premium = new Map<string, number>();
  const firstPrincipal = new Map<string, { id: string; refId: string | undefined }>(); // earliest principal entry
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  // Checkpoints: residual at each buy-in, plus who bought and how much principal it was.
  type Checkpoint = { residual: number; member: string; buyPrincipal: number; initial: boolean };
  const checkpoints: Checkpoint[] = [];
  const cashInById = new Map<string, { member: string; amount: number; refId: string | undefined }>();

  let cash = 0;
  let invested = 0;
  let contributedTotal = 0;

  for (const e of entries) {
    const mid = e.membershipId ? String(e.membershipId) : undefined;
    if (CASH_KINDS.has(e.kind)) cash += e.amount;

    if (e.kind === 'CASH_OUT_INVEST' && e.refId) {
      investCost.set(String(e.refId), -e.amount);
      invested += -e.amount;
    } else if (e.kind === 'INVEST_RETURN' && e.refId) {
      invested -= investCost.get(String(e.refId)) ?? 0;
    } else if ((e.kind === 'CASH_IN' || e.kind === 'OPENING_CONTRIBUTION') && mid) {
      add(contributed, mid, e.amount);
      contributedTotal += e.amount;
      if (!firstPrincipal.has(mid)) firstPrincipal.set(mid, { id: String(e._id), refId: e.refId ? String(e.refId) : undefined });
      if (e.kind === 'CASH_IN') cashInById.set(String(e._id), { member: mid, amount: e.amount, refId: e.refId ? String(e.refId) : undefined });
    } else if (e.kind === 'REVERSAL' && mid && e.reversalOf && kindById.get(String(e.reversalOf)) === 'CASH_IN') {
      add(contributed, mid, e.amount); // amount is negative
      contributedTotal += e.amount;
    } else if (e.kind === 'BUYIN_PREMIUM' && mid) {
      add(premium, mid, e.amount);
      // Pair with the buy-in's CASH_IN: same deposit refId (app flow) or refId = the CASH_IN id (correction).
      const ref = e.refId ? String(e.refId) : undefined;
      let buyCash = ref ? cashInById.get(ref) : undefined;
      if (!buyCash && ref) {
        for (const c of cashInById.values()) if (c.member === mid && c.refId === ref) buyCash = c;
      }
      const first = firstPrincipal.get(mid);
      const initial = !!first && !!ref && (first.id === ref || first.refId === ref);
      checkpoints.push({
        residual: cash + invested - contributedTotal,
        member: mid,
        buyPrincipal: (buyCash?.amount ?? 0) - e.amount,
        initial,
      });
    }
  }

  const principal = new Map<string, number>();
  for (const [m, c] of contributed) principal.set(m, c - (premium.get(m) ?? 0));

  // joinedAt[m] = checkpoint index where m first joined via buy-in (ineligible for segments ≤ it)
  const joinedAt = new Map<string, number>();
  checkpoints.forEach((c, i) => {
    if (c.initial && !joinedAt.has(c.member)) joinedAt.set(c.member, i);
  });

  const profit = new Map<string, number>();
  for (const [m, p] of premium) add(profit, m, p);

  const allocate = (segment: number, residualDelta: number) => {
    if (residualDelta === 0) return;
    const weights = new Map<string, number>();
    let total = 0;
    for (const [m, p] of principal) {
      const j = joinedAt.get(m);
      if (j !== undefined && j >= segment) continue;
      let w = p;
      for (let k = segment; k < checkpoints.length; k++) {
        const c = checkpoints[k]!;
        if (c.member === m && !c.initial) w -= c.buyPrincipal;
      }
      if (w > 0) {
        weights.set(m, w);
        total += w;
      }
    }
    if (total <= 0) return;
    for (const [m, w] of weights) add(profit, m, Math.round((w / total) * residualDelta));
  };

  let prevResidual = 0;
  checkpoints.forEach((c, k) => {
    allocate(k, c.residual - prevResidual);
    prevResidual = c.residual;
  });
  allocate(checkpoints.length, totalAssets - contributedTotal - prevResidual);

  const out = new Map<string, MemberPosition>();
  for (const [m, c] of contributed) {
    const value = (principal.get(m) ?? 0) + (profit.get(m) ?? 0);
    out.set(m, { contributed: c, value, profitShare: value - c });
  }
  return out;
}

/** One member's position (zeros if they've paid nothing). */
export async function memberPosition(
  fundId: Types.ObjectId | string,
  membershipId: Types.ObjectId | string,
  totalAssets: number,
  session?: ClientSession,
): Promise<MemberPosition> {
  const all = await fundMemberPositions(fundId, totalAssets, session);
  return all.get(String(membershipId)) ?? { contributed: 0, value: 0, profitShare: 0 };
}
