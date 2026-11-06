/**
 * Where an institution webhook may point (review finding: SSRF).
 * The API host POSTs to these URLs on a schedule with a signed body; it must never be steerable at
 * loopback, private, link-local or cloud-metadata addresses. Checked at registration against the
 * literal host AND every address it resolves to, and again at delivery (DNS can change).
 * https only; `WEBHOOK_ALLOW_INSECURE_URLS=true` permits http + private hosts for local tests and
 * is refused in production by config validation.
 */
import dns from 'dns/promises';
import net from 'net';

export function insecureUrlsAllowed(): boolean {
  return process.env.WEBHOOK_ALLOW_INSECURE_URLS === 'true' && process.env.NODE_ENV !== 'production';
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // not an IP literal we understand → treat as unsafe
}

export class WebhookUrlRejected extends Error { constructor(public readonly reason: string) { super(reason); } }

/** Throws WebhookUrlRejected. Returns the parsed URL on success. */
export async function assertDeliverableUrl(url: string): Promise<URL> {
  let u: URL; try { u = new URL(url); } catch { throw new WebhookUrlRejected('url must be absolute'); }
  if (u.username || u.password) throw new WebhookUrlRejected('credentials in url are not allowed');
  if (insecureUrlsAllowed()) { if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebhookUrlRejected('url must be http(s)'); return u; }
  if (u.protocol !== 'https:') throw new WebhookUrlRejected('webhook url must use https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) throw new WebhookUrlRejected('host must be a public DNS name');
  if (net.isIP(host)) { if (isPrivateAddress(host)) throw new WebhookUrlRejected('host resolves to a private address'); return u; }
  let addrs: { address: string }[];
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new WebhookUrlRejected('host does not resolve'); }
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new WebhookUrlRejected('host resolves to a private address');
  return u;
}
