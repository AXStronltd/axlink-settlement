import { createHmac } from 'crypto';

// Deliver a settlement event to a bank's registered webhook URL.
// Signed with HMAC-SHA256 so the bank can verify it came from AxLink.
// Retries up to MAX_RETRIES with exponential backoff (non-blocking — fire and forget).

const MAX_RETRIES = 3;

export interface BankWebhookPayload {
  event:           string;         // 'transfer.settled' | 'transfer.failed' | 'transfer.reversed'
  trackingId:      string;         // AxLink ref
  bankReferenceId: string;         // bank's own ref (echoed back)
  senderBankId:    string;
  receiverBankId:  string;
  senderCurrency:  string;
  senderAmount:    number;
  receiverCurrency: string;
  receiverAmount:  number;
  fxRate:          number | null;
  routeType:       string;
  fbTxId:          string | null;
  solanaTxHash:    string | null;
  settledAt:       string;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export async function deliverBankWebhook(
  webhookUrl: string,
  webhookSecret: string | null,
  payload: BankWebhookPayload,
  attempt = 1,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type':  'application/json',
    'X-AxLink-Event': payload.event,
    'X-AxLink-Delivery': `${payload.trackingId}-${attempt}`,
  };

  if (webhookSecret) {
    headers['X-AxLink-Signature'] = sign(body, webhookSecret);
  }

  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      console.log(`[BankWebhook] ✅ ${payload.event} → ${webhookUrl} (attempt ${attempt})`);
      return true;
    }
    console.warn(`[BankWebhook] ⚠️ ${webhookUrl} returned ${res.status} (attempt ${attempt})`);
  } catch (err) {
    console.warn(`[BankWebhook] ⚠️ ${webhookUrl} unreachable (attempt ${attempt}): ${err instanceof Error ? err.message : err}`);
  }

  if (attempt < MAX_RETRIES) {
    const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s
    setTimeout(() => deliverBankWebhook(webhookUrl, webhookSecret, payload, attempt + 1), delay);
  } else {
    console.error(`[BankWebhook] ❌ Gave up after ${MAX_RETRIES} attempts for ${payload.trackingId}`);
  }

  return false;
}
