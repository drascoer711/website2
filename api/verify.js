import { Redis } from '@upstash/redis';

const safeRedis = (() => {
  try {
    return Redis.fromEnv();
  } catch (error) {
    console.warn('[Redis Init] Missing or invalid Upstash env vars:', error.message);
    return null;
  }
})();

const fetchWithTimeout = async (url, options = {}, timeout = 3000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const safeString = (value, fallback = 'Unknown') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
};

const safeDecode = (value, fallback = 'Unknown') => {
  if (!value) return fallback;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return safeString(String(value), fallback);
  }
};

export default async function handler(req, res) {
  const rawUserId = req.query.user_id;
  const user_id = typeof rawUserId === 'string' ? rawUserId.trim() : '';

  if (!user_id || !/^\d{17,20}$/.test(user_id)) {
    return res.status(400).send('Missing or invalid user_id parameter.');
  }

  const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'Unknown IP';
  const country = safeString(req.headers['x-vercel-ip-country'], 'Unknown Country');
  const region = safeString(req.headers['x-vercel-ip-country-region'], 'Unknown Region');
  const city = safeDecode(req.headers['x-vercel-ip-city'], 'Unknown City');
  const userAgent = safeString(req.headers['user-agent'], 'Unknown Device');
  const acceptLanguage = safeString(req.headers['accept-language'], 'Unknown Language');
  const referer = safeString(req.headers['referer'], 'Direct / Unknown');

  const mobileHint = req.headers['sec-ch-ua-mobile'] === '?1' ? 'Mobile' : 'Desktop';
  const platformHint = req.headers['sec-ch-ua-platform'] ? req.headers['sec-ch-ua-platform'].replace(/"/g, '') : 'Unknown OS';
  const cpuCores = req.headers['sec-ch-ua-arch'] || req.headers['sec-ch-ua-bitness'] || 'Standard';

  let vpnDetected = false;
  let vpnDetails = 'None detected';
  let wifiProvider = 'Unknown ISP / Provider';
  let connectionType = 'Standard Residential';

  if (ip !== 'Unknown IP' && ip !== '127.0.0.1' && ip !== '::1') {
    try {
      const ipCheckRes = await fetchWithTimeout(`https://ipwho.is/${ip}`);
      if (ipCheckRes.ok) {
        const ipData = await ipCheckRes.json();
        if (ipData.success && ipData.connection) {
          const { type, isp, org } = ipData.connection;
          wifiProvider = safeString(isp || org || 'Unknown ISP', 'Unknown ISP');
          connectionType = safeString(type || 'Standard', 'Standard');

          const vpnRegex = /vpn|proxy|hosting|ovh|digitalocean|aws|hetzner|cloudflare|m247|choopa|linode|vultr/i;
          const combinedProvider = `${isp || ''} ${org || ''}`;

          if (type === 'hosting' || type === 'datacenter' || vpnRegex.test(combinedProvider)) {
            vpnDetected = true;
            vpnDetails = `ISP: ${safeString(isp || 'Unknown')} | Org: ${safeString(org || 'Unknown')} | Type: ${safeString(type || 'Hosting/VPN')}`;
          }
        }
      }
    } catch (err) {
      console.warn(`[IP API Error] Failed to fetch data for ${ip}:`, err.message);
    }
  }

  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const eq = cookie.indexOf('=');
        if (eq === -1) return [cookie, ''];
        const key = cookie.slice(0, eq).trim();
        const value = cookie.slice(eq + 1).trim();
        return [key, safeDecode(value, '')];
      })
  );

  const trackingCookieKey = cookies.alt_tracker_id;
  let browserAltDetected = null;
  let browserRingSize = 0;
  const newTrackingId = trackingCookieKey || Math.random().toString(36).slice(2) + Date.now().toString(36);
  const browserRedisKey = `device_track:${newTrackingId}`;

  if (safeRedis) {
    try {
      const previousBrowserUsers = await safeRedis.smembers(browserRedisKey);
      if (Array.isArray(previousBrowserUsers) && previousBrowserUsers.length > 0) {
        browserRingSize = previousBrowserUsers.length;
        const otherBrowserAlts = previousBrowserUsers.filter((id) => String(id) !== String(user_id));
        if (otherBrowserAlts.length > 0) {
          browserAltDetected = otherBrowserAlts.map((id) => `<@${id}> (\`${id}\`)`).join(', ');
        }
      }

      await safeRedis.sadd(browserRedisKey, user_id);
      await safeRedis.expire(browserRedisKey, 60 * 60 * 24 * 90);
    } catch (err) {
      console.error('[Redis Error] Browser tracking failed:', err.message);
    }
  }

  let ipAltWarning = null;
  let ipRingSize = 0;

  if (ip !== 'Unknown IP' && safeRedis) {
    const ipRedisKey = `ip_track_v2:${ip}`;
    try {
      const previousIpUsers = await safeRedis.smembers(ipRedisKey);
      if (Array.isArray(previousIpUsers) && previousIpUsers.length > 0) {
        ipRingSize = previousIpUsers.length;
        const otherIpAlts = previousIpUsers.filter((id) => String(id) !== String(user_id));
        if (otherIpAlts.length > 0) {
          ipAltWarning = otherIpAlts.map((id) => `<@${id}> (\`${id}\`)`).join(', ');
        }
      }

      await safeRedis.sadd(ipRedisKey, user_id);
      await safeRedis.expire(ipRedisKey, 60 * 60 * 24 * 30);
    } catch (err) {
      console.error('[Redis Error] IP tracking failed:', err.message);
    }
  }

  let accountAgeDays = 'Unknown';
  let altFlags = 'No alt heuristics triggered.';
  let badgeInfo = 'None detected';
  let avatarUrl = null;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (botToken) {
    try {
      const discordResponse = await fetchWithTimeout(`https://discord.com/api/v10/users/${user_id}`, {
        headers: { Authorization: `Bot ${botToken}` }
      });

      if (discordResponse.ok) {
        const userData = await discordResponse.json();
        if (userData.avatar) {
          const ext = userData.avatar.startsWith('a_') ? 'gif' : 'png';
          avatarUrl = `https://cdn.discordapp.com/avatars/${user_id}/${userData.avatar}.${ext}?size=128`;
        }

        const snowflake = BigInt(user_id);
        const timestamp = Number((snowflake >> 22n) + 1420070400000n);
        accountAgeDays = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));

        altFlags = accountAgeDays < 7
          ? `🚨 **High Risk Alt Indicator:** Account is only **${accountAgeDays} days old**`
          : `✅ Account age normal (**${accountAgeDays} days old**).`;

        const flags = userData.public_flags || 0;
        const flagMap = {
          1: 'Staff',
          2: 'Partner',
          4: 'HypeSquad Events',
          8: 'Bug Hunter Level 1',
          64: 'HypeSquad Bravery',
          128: 'HypeSquad Brilliance',
          256: 'HypeSquad Balance',
          512: 'Early Supporter',
          16384: 'Bug Hunter Level 2',
          131072: 'Early Verified Bot Developer'
        };

        const flagList = Object.entries(flagMap)
          .filter(([bit]) => flags & Number(bit))
          .map(([, name]) => name);

        if (flagList.length > 0) badgeInfo = flagList.join(', ');
      }
    } catch (err) {
      console.warn(`[Discord API Error] Failed fetching user ${user_id}:`, err.message);
    }
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const fields = [
      {
        name: '🌐 Network, ISP & Location Diagnostics',
        value: `• **IP:** \`${ip}\`\n• **WiFi/ISP:** \`${wifiProvider}\`\n• **Type:** \`${connectionType}\`\n• **Location:** \`${city}, ${region}, ${country}\`\n• **Network Ring Size:** ${ipRingSize}`,
        inline: false
      },
      {
        name: '🛡️ VPN / Proxy Detection',
        value: vpnDetected ? `🚨 **VPN/Hosting Detected!**\n\`${vpnDetails}\`` : '✅ Residential / Clean Network',
        inline: false
      },
      {
        name: '🕵️ Account Age & Badges',
        value: `• ${altFlags}\n• **Badges:** \`${badgeInfo}\``,
        inline: false
      }
    ];

    if (browserAltDetected) {
      fields.push({
        name: `🚨 SAME BROWSER ALT DETECTED! (Ring Size: ${browserRingSize})`,
        value: `Previously used by: ${browserAltDetected}\n(Cookie: \`${newTrackingId}\`)`,
        inline: false
      });
    }

    if (ipAltWarning) {
      fields.push({
        name: '🔗 Shared Network IP Match',
        value: `Same IP used by: ${ipAltWarning}`,
        inline: false
      });
    }

    fields.push({
      name: '💻 Hardware & Browser Telemetry',
      value: `• **Platform:** \`${platformHint} (${mobileHint})\`\n• **CPU:** \`${cpuCores}\`\n• **Lang:** \`${acceptLanguage.split(',')[0]}\``,
      inline: false
    });

    try {
      await fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '🛡️ Advanced Telemetry & Device Fingerprint',
            description: `User <@${user_id}> (\`${user_id}\`) triggered the verification gate.`,
            thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
            color: (vpnDetected || browserAltDetected || ipAltWarning || accountAgeDays < 7) ? 0xED4245 : 0x5865F2,
            fields,
            timestamp: new Date().toISOString()
          }]
        })
      });
    } catch (err) {
      console.error('[Webhook Error] Failed to send embed:', err.message);
    }
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'website2-umber-zeta.vercel.app';
  const redirectUrl = process.env.APP_URL || `${protocol}://${host}/`;

  res.setHeader('Set-Cookie', `alt_tracker_id=${newTrackingId}; Path=/; Max-Age=${60 * 60 * 24 * 90}; HttpOnly; Secure; SameSite=Lax`);
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}
