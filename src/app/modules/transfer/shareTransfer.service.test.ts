import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit/auditLog.model';
import { Lock } from '../_infra/lock.model';
import { Fund } from '../fund/fund.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { Membership, MembershipStatus } from '../membership/membership.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { User } from '../user/user.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { ShareTransfer } from './shareTransfer.model';
import {
  approveTransfer,
  buyerConfirmTransfer,
  cancelTransfer,
  expireStaleTransfers,
  initiateTransfer,
} from './shareTransfer.service';

let replSet: MongoMemoryReplSet;
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+88017${String(1000000 + phoneSeq).padStart(9, '0')}`;
}

async function createFundFixture(faceValue = 20000): Promise<{ fundId: Types.ObjectId; adminUserId: Types.ObjectId; adminMembershipId: Types.ObjectId }> {
  const admin = await User.create({ phone: nextPhone(), name: 'Admin', passwordHash: 'hash' });
  const fund = await Fund.create({
    name: 'Transfer Test Fund',
    faceValue,
    policy: {
      cycleUnit: 'WEEKLY',
      startDate: new Date(),
    },
    createdBy: admin._id,
  });
  const adminMembership = await Membership.create({
    userId: admin._id,
    fundId: fund._id,
    role: 'admin',
    status: 'ACTIVE',
    shares: 0,
    joinNav: faceValue,
  });
  return { fundId: fund._id, adminUserId: admin._id, adminMembershipId: adminMembership._id };
}

async function createMember(
  fundId: Types.ObjectId,
  opts: { shares: number; cash?: number; status?: MembershipStatus; phone?: string; actorId: Types.ObjectId },
): Promise<{ userId: Types.ObjectId; membershipId: Types.ObjectId; phone: string }> {
  const phone = opts.phone ?? nextPhone();
  const user = await User.create({ phone, name: `Member ${phone}`, passwordHash: 'hash' });
  const membership = await Membership.create({
    userId: user._id,
    fundId,
    role: 'member',
    status: opts.status ?? 'ACTIVE',
    shares: opts.shares,
    joinNav: 20000,
  });
  if (opts.shares > 0) {
    await appendLedger({ fundId, kind: 'SHARES_ISSUED', shares: opts.shares, membershipId: membership._id, createdBy: opts.actorId });
  }
  if (opts.cash) {
    await appendLedger({ fundId, kind: 'CASH_IN', amount: opts.cash, membershipId: membership._id, createdBy: opts.actorId });
  }
  return { userId: user._id, membershipId: membership._id, phone };
}

describe('shareTransfer service', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'samity_transfer_service' });
  }, 120_000);

  beforeEach(async () => {
    phoneSeq = 0;
    await Promise.all([
      AuditLog.deleteMany({}),
      Fund.deleteMany({}),
      LedgerEntry.deleteMany({}),
      Lock.deleteMany({}),
      Membership.deleteMany({}),
      NavSnapshot.deleteMany({}),
      ShareTransfer.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  describe('initiateTransfer', () => {
    it('creates an INITIATED transfer with sellerConfirmed=true, buyerConfirmed=false, expiresAt ~72h out', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });

      const before = Date.now();
      const result = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: nextPhone(),
      });
      const after = Date.now();

      expect(result.state).toBe('INITIATED');

      const transfer = await ShareTransfer.findById(result.transferId).lean();
      expect(transfer).toMatchObject({ state: 'INITIATED', sellerConfirmed: true, buyerConfirmed: false, shares: 2, agreedAmount: 40000 });
      expect(transfer?.expiresAt).toBeInstanceOf(Date);
      const expiresAtMs = transfer!.expiresAt!.getTime();
      const seventyTwoHoursMs = 72 * 60 * 60 * 1000;
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + seventyTwoHoursMs - 5000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + seventyTwoHoursMs + 5000);
    });

    it('prices navAtTransfer from the seller\'s own contribution-based reference, not fund-wide nav × shares', async () => {
      const { fundId, adminUserId } = await createFundFixture(20000);
      // Seller under-contributed relative to their shares (paid 10000/share); another member
      // over-contributed (paid 35000/share) — so the fund-wide picture differs sharply from the
      // seller's own stake. No investment profit yet, so profit=0 and value=contributed exactly.
      const seller = await createMember(fundId, { shares: 6, cash: 60000, actorId: adminUserId });
      await createMember(fundId, { shares: 4, cash: 140000, actorId: adminUserId });

      const result = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 3,
        agreedAmount: 40000,
        toPhone: nextPhone(),
      });

      const transfer = await ShareTransfer.findById(result.transferId).lean();
      // sellerReferencePrice: contributed(60000)/shares(6) * transferShares(3) = 30000
      expect(transfer?.navAtTransfer).toBe(30000);

      const nav = await computeNav(fundId);
      expect(nav.nav).toBe(20000); // cyclesElapsed=0 -> anchors to faceValue
      // Fund-wide nav × shares would give 60000 — provably NOT what was used.
      expect(transfer?.navAtTransfer).not.toBe(nav.nav * 3);
    });

    it('rejects a seller who does not hold enough shares', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 2, actorId: adminUserId });

      await expect(
        initiateTransfer(String(seller.membershipId), String(fundId), {
          shares: 5,
          agreedAmount: 10000,
          toPhone: nextPhone(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION', statusCode: 400 });
    });

    it('resolves the buyer by phone when they are already an active member', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const result = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });

      const transfer = await ShareTransfer.findById(result.transferId).lean();
      expect(transfer?.toUserId).toEqual(buyer.userId);
      expect(transfer?.toMembershipId).toEqual(buyer.membershipId);
    });

    it('leaves the transfer as toPhone-only when the buyer is not yet on the app', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const strangerPhone = nextPhone();

      const result = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: strangerPhone,
      });

      const transfer = await ShareTransfer.findById(result.transferId).lean();
      expect(transfer?.toPhone).toBe(strangerPhone);
      expect(transfer?.toUserId).toBeUndefined();
      expect(transfer?.toMembershipId).toBeUndefined();
    });
  });

  describe('buyerConfirmTransfer', () => {
    it('rejects confirmation from someone other than the intended buyer', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });
      const impostor = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });

      await expect(buyerConfirmTransfer(String(impostor.userId), String(fundId), transferId)).rejects.toMatchObject({
        code: 'FORBIDDEN_ROLE',
        statusCode: 403,
      });
    });

    it('flips state to BOTH_CONFIRMED once the buyer confirms', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });

      const result = await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);
      expect(result.state).toBe('BOTH_CONFIRMED');

      const transfer = await ShareTransfer.findById(transferId).lean();
      expect(transfer).toMatchObject({ state: 'BOTH_CONFIRMED', buyerConfirmed: true, sellerConfirmed: true });
    });

    it('lets a buyer who registered after initiation confirm by matching phone', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const strangerPhone = nextPhone();

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: strangerPhone,
      });

      // Buyer registers only now — no membership yet, but phone matches.
      const newUser = await User.create({ phone: strangerPhone, name: 'New Buyer', passwordHash: 'hash' });

      const result = await buyerConfirmTransfer(String(newUser._id), String(fundId), transferId);
      expect(result.state).toBe('BOTH_CONFIRMED');
    });

    it('rejects confirming an already-confirmed (non-INITIATED) transfer', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });

      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);

      await expect(buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        statusCode: 409,
      });
    });
  });

  describe('approveTransfer', () => {
    it('is only callable once BOTH_CONFIRMED', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });

      await expect(approveTransfer(String(adminUserId), String(fundId), transferId)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        statusCode: 409,
      });
    });

    it('atomically reassigns shares, appends two net-zero SHARES_TRANSFER entries, and marks APPROVED', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 6, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 2, actorId: adminUserId });

      const totalSharesBefore = (await computeNav(fundId)).totalShares;

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 3,
        agreedAmount: 60000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);

      const result = await approveTransfer(String(adminUserId), String(fundId), transferId);
      expect(result.state).toBe('APPROVED');

      const sellerMembership = await Membership.findById(seller.membershipId).lean();
      const buyerMembership = await Membership.findById(buyer.membershipId).lean();
      expect(sellerMembership?.shares).toBe(3);
      expect(buyerMembership?.shares).toBe(5);
      expect(sellerMembership?.status).toBe('ACTIVE'); // still holds shares

      const entries = await LedgerEntry.find({ fundId, kind: 'SHARES_TRANSFER', refId: new Types.ObjectId(transferId) }).lean();
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ membershipId: seller.membershipId, shares: -3 }),
          expect.objectContaining({ membershipId: buyer.membershipId, shares: 3 }),
        ]),
      );

      const totalSharesAfter = (await computeNav(fundId)).totalShares;
      expect(totalSharesAfter).toBe(totalSharesBefore);

      const transfer = await ShareTransfer.findById(transferId).lean();
      expect(transfer?.state).toBe('APPROVED');

      const audit = await AuditLog.findOne({ fundId, action: 'TRANSFER_APPROVE' }).lean();
      expect(audit).toBeTruthy();
    });

    it('exits the seller when their share balance hits 0', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 3, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 3,
        agreedAmount: 60000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);
      await approveTransfer(String(adminUserId), String(fundId), transferId);

      const sellerMembership = await Membership.findById(seller.membershipId).lean();
      expect(sellerMembership).toMatchObject({ shares: 0, status: 'EXITED' });
    });

    it('activates a PENDING_BUYIN buyer once shares land', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 0, status: 'PENDING_BUYIN', actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);
      await approveTransfer(String(adminUserId), String(fundId), transferId);

      const buyerMembership = await Membership.findById(buyer.membershipId).lean();
      expect(buyerMembership).toMatchObject({ shares: 2, status: 'ACTIVE' });
    });

    it('rejects approving an already-APPROVED transfer', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);
      await approveTransfer(String(adminUserId), String(fundId), transferId);

      await expect(approveTransfer(String(adminUserId), String(fundId), transferId)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        statusCode: 409,
      });
    });
  });

  describe('cancelTransfer', () => {
    it('lets the seller cancel an INITIATED transfer', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: nextPhone(),
      });

      const result = await cancelTransfer(String(seller.membershipId), 'member', String(fundId), transferId);
      expect(result.state).toBe('CANCELLED');
    });

    it('lets an admin/mod cancel a BOTH_CONFIRMED transfer', async () => {
      const { fundId, adminUserId, adminMembershipId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);

      const result = await cancelTransfer(String(adminMembershipId), 'admin', String(fundId), transferId);
      expect(result.state).toBe('CANCELLED');
    });

    it('rejects cancellation from a non-seller, non-manager member', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });
      const bystander = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: nextPhone(),
      });

      await expect(
        cancelTransfer(String(bystander.membershipId), 'member', String(fundId), transferId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE', statusCode: 403 });
    });

    it('cannot cancel an APPROVED transfer', async () => {
      const { fundId, adminUserId, adminMembershipId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });
      const buyer = await createMember(fundId, { shares: 1, actorId: adminUserId });

      const { transferId } = await initiateTransfer(String(seller.membershipId), String(fundId), {
        shares: 2,
        agreedAmount: 40000,
        toPhone: buyer.phone,
      });
      await buyerConfirmTransfer(String(buyer.userId), String(fundId), transferId);
      await approveTransfer(String(adminUserId), String(fundId), transferId);

      await expect(
        cancelTransfer(String(seller.membershipId), 'member', String(fundId), transferId),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT', statusCode: 409 });
    });
  });

  describe('expireStaleTransfers', () => {
    it('flips a stale INITIATED transfer to EXPIRED when swept past its expiry', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });

      const transfer = await ShareTransfer.create({
        fundId,
        fromMembershipId: seller.membershipId,
        toPhone: nextPhone(),
        shares: 2,
        agreedAmount: 40000,
        sellerConfirmed: true,
        buyerConfirmed: false,
        state: 'INITIATED',
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expireStaleTransfers(new Date());

      const after = await ShareTransfer.findById(transfer._id).lean();
      expect(after?.state).toBe('EXPIRED');
    });

    it('leaves a transfer with a future expiresAt untouched', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });

      const transfer = await ShareTransfer.create({
        fundId,
        fromMembershipId: seller.membershipId,
        toPhone: nextPhone(),
        shares: 2,
        agreedAmount: 40000,
        sellerConfirmed: true,
        buyerConfirmed: false,
        state: 'INITIATED',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      await expireStaleTransfers(new Date());

      const after = await ShareTransfer.findById(transfer._id).lean();
      expect(after?.state).toBe('INITIATED');
    });

    it('leaves an already-APPROVED or already-CANCELLED transfer alone even if past expiresAt', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });

      const [approved, cancelled] = await ShareTransfer.create([
        {
          fundId,
          fromMembershipId: seller.membershipId,
          toPhone: nextPhone(),
          shares: 2,
          agreedAmount: 40000,
          sellerConfirmed: true,
          buyerConfirmed: true,
          state: 'APPROVED',
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          fundId,
          fromMembershipId: seller.membershipId,
          toPhone: nextPhone(),
          shares: 1,
          agreedAmount: 20000,
          sellerConfirmed: true,
          buyerConfirmed: false,
          state: 'CANCELLED',
          expiresAt: new Date(Date.now() - 60_000),
        },
      ]);

      await expireStaleTransfers(new Date());

      await expect(ShareTransfer.findById(approved!._id).lean()).resolves.toMatchObject({ state: 'APPROVED' });
      await expect(ShareTransfer.findById(cancelled!._id).lean()).resolves.toMatchObject({ state: 'CANCELLED' });
    });

    it('is idempotent — sweeping twice does not error or change an already-EXPIRED transfer', async () => {
      const { fundId, adminUserId } = await createFundFixture();
      const seller = await createMember(fundId, { shares: 4, actorId: adminUserId });

      const transfer = await ShareTransfer.create({
        fundId,
        fromMembershipId: seller.membershipId,
        toPhone: nextPhone(),
        shares: 2,
        agreedAmount: 40000,
        sellerConfirmed: true,
        buyerConfirmed: false,
        state: 'INITIATED',
        expiresAt: new Date(Date.now() - 60_000),
      });

      const now = new Date();
      await expireStaleTransfers(now);
      await expect(expireStaleTransfers(now)).resolves.toBeUndefined();

      const after = await ShareTransfer.findById(transfer._id).lean();
      expect(after?.state).toBe('EXPIRED');
    });
  });
});
