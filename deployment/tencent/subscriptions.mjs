import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { platformDatabase } from './platform-database.mjs';

const dayMilliseconds = 86400000;
export const subscriptionPlans = [
  { id: 'monthly', name: '月卡', priceCents: 800, days: 30, quotaBytes: 5 * 1024 ** 3 },
  { id: 'quarterly', name: '季卡', priceCents: 2000, days: 90, quotaBytes: 10 * 1024 ** 3 },
  { id: 'yearly', name: '年卡', priceCents: 8800, days: 365, quotaBytes: 20 * 1024 ** 3 },
];

export function isSubscriptionExpired(account, now = Date.now()) {
  return account.role !== 'admin' && account.subscription_expires_at !== null && account.subscription_expires_at <= now;
}

export function getSubscription(account, now = Date.now()) {
  const permanent = account.role === 'admin' || account.subscription_expires_at === null;
  const plan = subscriptionPlans.find(item => item.id === account.subscription_plan);
  return {
    planId: account.subscription_plan,
    planName: account.role === 'admin' ? '平台管理员' : plan ? plan.name : '长期有效',
    expiresAt: permanent ? null : account.subscription_expires_at,
    expired: isSubscriptionExpired(account, now), permanent,
    daysRemaining: permanent ? null : Math.max(0, Math.ceil((account.subscription_expires_at - now) / dayMilliseconds)),
    quotaBytes: account.quota_bytes,
  };
}

export function calculateSubscriptionExpiry(durationDays, currentExpiresAt, now) {
  const duration = durationDays * dayMilliseconds;
  const expiresAt = Math.max(now, currentExpiresAt ?? now) + duration;
  return Number.isSafeInteger(duration) && Number.isSafeInteger(expiresAt) && expiresAt <= 8640000000000000 ? expiresAt : null;
}

// Both batch generation and order fulfillment insert this inside their own transaction.
export function insertSubscriptionCode({ plan, durationDays = plan.days, quotaBytes = plan.quotaBytes, expiresAt, createdBy, note, now }) {
  const code = `YY-${randomBytes(18).toString('base64url')}`;
  const invitationId = randomUUID();
  platformDatabase.prepare(`INSERT INTO invitations
    (id,token_hash,hint,note,quota_bytes,created_by,created_at,expires_at,subscription_plan,duration_days)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(invitationId, createHash('sha256').update(code).digest('hex'), `${code.slice(0, 7)}…${code.slice(-4)}`,
      note, quotaBytes, createdBy, new Date(now).toISOString(), expiresAt, plan.id, durationDays);
  return { code, invitationId };
}

export function createSubscriptionCodes({ planId, count, validityDays, durationDays, quotaBytes, createdBy, note }) {
  const preset = subscriptionPlans.find(item => item.id === planId);
  if (!preset) throw new Error('Unknown subscription plan.');
  const plan = { ...preset, days: durationDays ?? preset.days, quotaBytes: quotaBytes ?? preset.quotaBytes, permanent: false };
  const now = Date.now();
  const codes = [];
  const invitationIds = [];
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < count; index++) {
      const issued = insertSubscriptionCode({ plan, durationDays: plan.days, expiresAt: validityDays ? now + validityDays * dayMilliseconds : null, createdBy, note, now });
      codes.push(issued.code);
      invitationIds.push(issued.invitationId);
    }
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
  return { codes, invitationIds, plan };
}

export function readSubscriptionInvitation(code, now) {
  return platformDatabase.prepare(`SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>?) AND (subscription_plan IS NOT NULL OR grants_permanent=1)`)
    .get(createHash('sha256').update(code).digest('hex'), now);
}

// Registration and renewal both call this inside their invitation-consumption transaction.
export function applySubscriptionInvitation(account, invitation, now) {
  const permanent = invitation.grants_permanent === 1;
  const expiresAt = permanent ? null : calculateSubscriptionExpiry(invitation.duration_days, account.subscription_expires_at, now);
  if (!permanent && expiresAt === null) throw new RangeError('Subscription expiry exceeds supported dates.');
  platformDatabase.prepare(`UPDATE users SET subscription_plan=?,subscription_expires_at=?,quota_bytes=?,subscription_reminded_on=NULL WHERE id=?`)
    .run(invitation.subscription_plan, expiresAt, invitation.quota_bytes, account.id);
  platformDatabase.prepare(`INSERT INTO subscription_redemptions
    (invitation_id,user_id,plan_id,duration_days,previous_plan,previous_expires_at,expires_at,previous_quota_bytes,quota_bytes,redeemed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(invitation.id, account.id, invitation.subscription_plan, invitation.duration_days, account.subscription_plan,
      account.subscription_expires_at, expiresAt, account.quota_bytes, invitation.quota_bytes, new Date(now).toISOString());
}
