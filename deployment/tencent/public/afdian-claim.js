const form = document.querySelector('#afdian-claim-form');
const orderInput = document.querySelector('#afdian-order-number');
const submit = document.querySelector('#afdian-claim-submit');
const status = document.querySelector('#afdian-claim-status');
let configured = false;
let sending = false;

async function loadDeliveryStatus() {
  try {
    const response = await fetch('/api/integrations/afdian/delivery/status', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || typeof result.configured !== 'boolean') throw new Error('Invalid delivery status.');
    configured = result.configured;
    orderInput.disabled = submit.disabled = !configured;
    status.dataset.kind = configured ? 'ready' : 'pending';
    status.textContent = configured
      ? '发货通道已就绪，请填写订单号。'
      : '发货通道准备中，待套餐配置完成后开放。';
  } catch {
    status.dataset.kind = 'error';
    status.textContent = '暂时无法检查发货通道，请刷新页面重试。';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!configured || sending) return;
  const orderNo = orderInput.value.trim();
  if (!orderNo) {
    status.dataset.kind = 'error';
    status.textContent = '请输入完整的爱发电订单号。';
    orderInput.focus();
    return;
  }
  sending = true;
  orderInput.disabled = submit.disabled = true;
  submit.textContent = '正在核验订单…';
  form.setAttribute('aria-busy', 'true');
  status.dataset.kind = 'pending';
  status.textContent = '正在核验订单并触发发货，请稍候。';
  try {
    const response = await fetch('/api/integrations/afdian/delivery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNo }),
    });
    const result = await response.json();
    if (!response.ok) {
      status.dataset.kind = 'error';
      status.textContent = typeof result.error === 'string' ? result.error : '暂时无法完成发货，请稍后重试。';
      return;
    }
    if (!['sent', 'processing'].includes(result.status) || typeof result.message !== 'string') {
      throw new Error('Invalid delivery result.');
    }
    status.dataset.kind = result.status === 'sent' ? 'success' : 'pending';
    status.textContent = result.message;
    if (result.status === 'sent') orderInput.value = '';
  } catch {
    status.dataset.kind = 'error';
    status.textContent = '暂时无法完成发货，请稍后重试。重复提交不会生成新的兑换码。';
  } finally {
    sending = false;
    orderInput.disabled = submit.disabled = !configured;
    submit.textContent = '触发发货';
    form.removeAttribute('aria-busy');
  }
});

void loadDeliveryStatus();
