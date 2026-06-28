import { ClientSession, Types } from 'mongoose';
import { LedgerEntry, LedgerEntryDoc, LedgerKind, LedgerRefType } from '../app/modules/ledger/ledgerEntry.model';

export interface LedgerAppend {
  fundId: Types.ObjectId | string;
  kind: LedgerKind;
  amount?: number; // signed paisa (default 0)
  shares?: number; // signed int (default 0)
  cyclesCovered?: number;
  membershipId?: Types.ObjectId | string;
  fromMembershipId?: Types.ObjectId | string;
  toMembershipId?: Types.ObjectId | string;
  refType?: LedgerRefType;
  refId?: Types.ObjectId | string;
  reversalOf?: Types.ObjectId | string;
  createdBy: Types.ObjectId | string;
}

/**
 * Append one immutable LedgerEntry — the ONLY way money/shares enter the system of record.
 * Always called inside the money-mutation transaction (pass the session).
 */
export async function appendLedger(entry: LedgerAppend, session?: ClientSession): Promise<LedgerEntryDoc> {
  const [doc] = await LedgerEntry.create([{ ...entry, at: new Date() }], session ? { session } : {});
  return doc!;
}
