const banner = document.querySelector('#subscription-status');
let latestSubscription;
const expiryDate = value => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });

function renderSubscriptionBanner(subscription) {
  latestSubscription = subscription;
  document.body.dataset.subscriptionExpired = String(subscription.expired);
  const upload = document.querySelector('#open-upload');
  if (upload) { upload.disabled = subscription.expired || document.body.dataset.photoBusy === 'true'; upload.title = subscription.expired ? '订阅已到期，请先兑换续期' : ''; }
  const nearExpiry = !subscription.permanent && !subscription.expired && subscription.daysRemaining <= 7;
  banner.hidden = !subscription.expired && !nearExpiry;
  if (banner.hidden) return;
  banner.dataset.expired = String(subscription.expired);
  banner.innerHTML = '<div><strong></strong><p></p></div><a class="button secondary small" href="/dashboard/subscription">兑换续期</a>';
  banner.querySelector('strong').textContent = subscription.expired ? '订阅已到期' : `订阅将在 ${subscription.daysRemaining} 天内到期`;
  banner.querySelector('p').textContent = subscription.expired
    ? '照片已保留，公开展示和上传暂停。登录后仍可下载自己的原图，并使用兑换码续期。'
    : `到期时间：${expiryDate(subscription.expiresAt)}。可提前兑换续期，未用完的时长继续保留。`;
}

async function loadSubscriptionReminder() {
  try {
    const response = await fetch('/api/profile/subscription');
    if (!response.ok) throw new Error('Unable to load subscription');
    const { subscription } = await response.json();
    renderSubscriptionBanner(subscription);
    if (subscription.permanent || subscription.expired || subscription.daysRemaining > 7) return;
    const claim = await fetch('/api/profile/subscription/reminder', { method: 'POST' });
    if (!claim.ok) throw new Error('Unable to read subscription reminder');
    const reminder = await claim.json();
    if (!reminder.showReminder) return;
    while (document.querySelector('dialog[open]')) {
      await new Promise(resolve => document.querySelector('dialog[open]').addEventListener('close', resolve, { once: true }));
    }
    if (latestSubscription.permanent || latestSubscription.expired || latestSubscription.daysRemaining > 7
      || latestSubscription.expiresAt !== reminder.subscription.expiresAt) return;
    const element = document.createElement('dialog');
    element.className = 'modern-dialog subscription-reminder-dialog';
    element.setAttribute('aria-labelledby', 'subscription-reminder-title');
    element.innerHTML = '<div class="dialog-heading"><h2 id="subscription-reminder-title">订阅即将到期</h2><button type="button" class="dialog-close" aria-label="关闭提醒">×</button></div><p class="subscription-reminder-message"></p><p class="field-note">提前续期会保留剩余时长。到期后照片保留，公开展示和上传暂停。</p><div class="form-actions"><button type="button" class="button secondary">今天不再提醒</button><a class="button primary" href="/dashboard/subscription">去兑换续期</a></div>';
    element.querySelector('.subscription-reminder-message').textContent = `当前订阅剩余 ${reminder.subscription.daysRemaining} 天，将于 ${expiryDate(reminder.subscription.expiresAt)} 到期。`;
    element.querySelectorAll('button').forEach(button => button.addEventListener('click', () => element.close()));
    element.addEventListener('close', () => element.remove(), { once: true });
    document.body.append(element);
    element.showModal();
  } catch {
    banner.hidden = false;
    banner.classList.add('subscription-status-unavailable');
    banner.innerHTML = '<p>订阅状态暂时无法读取，请刷新后重试。</p><a class="button secondary small" href="/dashboard/subscription">查看订阅</a>';
  }
}

window.addEventListener('subscription-updated', event => renderSubscriptionBanner(event.detail));
void loadSubscriptionReminder();
