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

  const ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'Unknown IP';

  const country = safeString(req.headers['x-vercel-ip-country'], 'Unknown Country');
  const region = safeString(req.headers['x-vercel-ip-country-region'], 'Unknown Region');
  const city = safeDecode(req.headers['x-vercel-ip-city'], 'Unknown City');
  const userAgent = safeString(req.headers['user-agent'], 'Unknown Device');
  const acceptLanguage = safeString(req.headers['accept-language'], 'Unknown Language');
  const referer = safeString(req.headers['referer'], 'Direct / Unknown');
  const timestamp = new Date().toISOString();

  const mobileHint = req.headers['sec-ch-ua-mobile'] === '?1' ? 'Mobile' : 'Desktop';
  const platformHint = req.headers['sec-ch-ua-platform']
    ? req.headers['sec-ch-ua-platform'].replace(/"/g, '')
    : 'Unknown OS';
  const cpuCores = req.headers['sec-ch-ua-arch'] || req.headers['sec-ch-ua-bitness'] || 'Standard';

  // Enhanced VPN & IP Intelligence
  let vpnDetected = false;
  let vpnRiskLevel = 'None';
  let vpnDetails = 'None detected';
  let wifiProvider = 'Unknown ISP / Provider';
  let connectionType = 'Standard Residential';
  let isp = 'Unknown';
  let org = 'Unknown';
  let asn = 'Unknown';
  let isDatacenter = false;
  let isHosting = false;
  let isProxy = false;

  if (ip !== 'Unknown IP' && ip !== '127.0.0.1' && ip !== '::1') {
    try {
      const ipCheckRes = await fetchWithTimeout(`https://ipwho.is/${ip}`);
      if (ipCheckRes.ok) {
        const ipData = await ipCheckRes.json();
        if (ipData.success && ipData.connection) {
          const { type, isp: ispData, org: orgData, asn: asnData, is_datacenter, is_hosting, is_proxy } = ipData.connection;

          isp = safeString(ispData || 'Unknown ISP', 'Unknown ISP');
          org = safeString(orgData || 'Unknown Org', 'Unknown Org');
          asn = safeString(asnData || 'Unknown ASN', 'Unknown ASN');
          wifiProvider = isp;
          connectionType = safeString(type || 'Standard', 'Standard');

          isDatacenter = is_datacenter === true;
          isHosting = is_hosting === true;
          isProxy = is_proxy === true;

          const vpnRegex = /vpn|proxy|hosting|ovh|digitalocean|aws|hetzner|cloudflare|m247|choopa|linode|vultr|oracle|azure|gcp|akamai|fastly|level3|cogent|ntt|sprint|verizon/i;
          const combinedProvider = `${isp || ''} ${org || ''}`;

          if (type === 'hosting' || type === 'datacenter' || isDatacenter || isHosting) {
            vpnDetected = true;
            vpnRiskLevel = 'HIGH';
            vpnDetails = `ISP: ${isp} | Org: ${org} | ASN: ${asn} | Type: Datacenter/Hosting`;
          } else if (isProxy || type === 'proxy') {
            vpnDetected = true;
            vpnRiskLevel = 'MEDIUM';
            vpnDetails = `ISP: ${isp} | Org: ${org} | ASN: ${asn} | Type: Proxy Detected`;
          } else if (vpnRegex.test(combinedProvider)) {
            vpnDetected = true;
            vpnRiskLevel = 'MEDIUM';
            vpnDetails = `ISP: ${isp} | Org: ${org} | ASN: ${asn} | Type: Known VPN/Hosting Provider`;
          }
        }
      }
    } catch (err) {
      console.warn(`[IP API Error] Failed to fetch data for ${ip}:`, err.message);
    }
  }

  // Enhanced Cookie & Alt Tracking
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

  // Enhanced IP Alt Tracking with geo data
  let ipAltWarning = null;
  let ipRingSize = 0;
  let geoRiskAssessment = 'Low';

  if (ip !== 'Unknown IP' && safeRedis) {
    const ipRedisKey = `ip_track_v2:${ip}`;
    try {
      const previousIpUsers = await safeRedis.smembers(ipRedisKey);
      if (Array.isArray(previousIpUsers) && previousIpUsers.length > 0) {
        ipRingSize = previousIpUsers.length;
        const otherIpAlts = previousIpUsers.filter((id) => String(id) !== String(user_id));
        if (otherIpAlts.length > 0) {
          ipAltWarning = otherIpAlts.map((id) => `<@${id}> (\`${id}\`)`).join(', ');
          geoRiskAssessment = ipRingSize > 5 ? 'Very High' : ipRingSize > 3 ? 'High' : 'Medium';
        }
      }

      await safeRedis.sadd(ipRedisKey, user_id);
      await safeRedis.expire(ipRedisKey, 60 * 60 * 24 * 30);
    } catch (err) {
      console.error('[Redis Error] IP tracking failed:', err.message);
    }
  }

  // Enhanced Discord User Details
  let accountAgeDays = 'Unknown';
  let altFlags = 'No alt heuristics triggered.';
  let badgeInfo = 'None detected';
  let avatarUrl = null;
  let accountCreationRisk = 'Low';
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
        const timestampDiscord = Number((snowflake >> 22n) + 1420070400000n);
        accountAgeDays = Math.floor((Date.now() - timestampDiscord) / (1000 * 60 * 60 * 24));

        if (accountAgeDays < 1) {
          altFlags = `🚨 **CRITICAL:** Account created TODAY!`;
          accountCreationRisk = 'Critical';
        } else if (accountAgeDays < 7) {
          altFlags = `🚨 **High Risk Alt:** Account is only **${accountAgeDays} days old**`;
          accountCreationRisk = 'High';
        } else if (accountAgeDays < 30) {
          altFlags = `⚠️ **Moderate Risk:** Account is **${accountAgeDays} days old**`;
          accountCreationRisk = 'Medium';
        } else {
          altFlags = `✅ Account age normal (**${accountAgeDays} days old**).`;
          accountCreationRisk = 'Low';
        }

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

  const riskFactors = [];
  if (vpnDetected) riskFactors.push(`VPN/Proxy (${vpnRiskLevel})`);
  if (accountCreationRisk !== 'Low') riskFactors.push(`New Account (${accountCreationRisk})`);
  if (geoRiskAssessment !== 'Low') riskFactors.push(`Geo Risk (${geoRiskAssessment})`);
  if (browserAltDetected) riskFactors.push('Alt Account Detected');
  if (ipAltWarning) riskFactors.push('IP Shared Multiple Users');

  let overallRiskScore = 'LOW';
  if (riskFactors.length >= 3) overallRiskScore = 'CRITICAL';
  else if (riskFactors.length === 2) overallRiskScore = 'HIGH';
  else if (riskFactors.length === 1) overallRiskScore = 'MEDIUM';

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const fields = [
      {
        name: '⚠️ OVERALL RISK ASSESSMENT',
        value: `**Risk Level: \`${overallRiskScore}\`**\nRisk Factors: ${riskFactors.length > 0 ? riskFactors.join(' | ') : 'None detected'}`,
        inline: false
      },
      {
        name: '🌍 Location & Network',
        value: `• **IP Address:** \`${ip}\`\n• **Country:** \`${country}\`\n• **Region:** \`${region}\`\n• **City:** \`${city}\`\n• **ISP:** \`${isp}\`\n• **Organization:** \`${org}\`\n• **ASN:** \`${asn}\`\n• **Connection Type:** \`${connectionType}\``,
        inline: false
      },
      {
        name: '🔍 VPN & Proxy Detection',
        value: vpnDetected
          ? `**🚨 DETECTED - Risk Level: \`${vpnRiskLevel}\`**\n${vpnDetails}\n• Datacenter: \`${isDatacenter ? 'YES' : 'NO'}\`\n• Hosting: \`${isHosting ? 'YES' : 'NO'}\`\n• Proxy: \`${isProxy ? 'YES' : 'NO'}\``
          : `✅ No VPN/Proxy Detected (Residential Network)`,
        inline: false
      },
      {
        name: '📱 Device & Browser Telemetry',
        value: `• **Platform:** \`${platformHint} (${mobileHint})\`\n• **CPU/Arch:** \`${cpuCores}\`\n• **User Agent:** \`${userAgent}\`\n• **Language:** \`${acceptLanguage.split(',')[0]}\`\n• **Referer:** \`${referer}\``,
        inline: false
      },
      {
        name: '👤 Account Details',
        value: `• ${altFlags}\n• **Badges:** \`${badgeInfo}\`\n• **Account Age:** \`${accountAgeDays} days\`\n• **Risk Level:** \`${accountCreationRisk}\``,
        inline: false
      },
      {
        name: `🔗 Network Ring Analysis`,
        value: `• **Same IP Users:** \`${ipRingSize}\`\n• **Geo Risk:** \`${geoRiskAssessment}\`${ipAltWarning ? `\n• **Shared With:** ${ipAltWarning}` : ''}`,
        inline: false
      }
    ];

    if (browserAltDetected) {
      fields.push({
        name: `🚨 BROWSER ALT DETECTION (Ring: ${browserRingSize})`,
        value: `**Previously used by:** ${browserAltDetected}\n**Device Cookie ID:** \`${newTrackingId}\``,
        inline: false
      });
    }

    fields.push({
      name: '⏰ Verification Metadata',
      value: `• **Timestamp:** \`${timestamp}\`\n• **User ID:** \`${user_id}\`\n• **Tracking ID:** \`${newTrackingId}\``,
      inline: false
    });

    try {
      await fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'YPL Security Monitor',
          avatar_url: 'https://cdn-icons-png.flaticon.com/512/3556/3556198.png',
          embeds: [{
            title: `🛡️ YPL Verification - ${overallRiskScore} RISK`,
            description: `User <@${user_id}> (\`${user_id}\`) triggered verification gate.`,
            thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
            color:
              overallRiskScore === 'CRITICAL' ? 0xFF0000 :
              overallRiskScore === 'HIGH' ? 0xFF6600 :
              overallRiskScore === 'MEDIUM' ? 0xFFAA00 :
              0x00AA00,
            fields,
            timestamp: timestamp,
            footer: {
              text: 'YPL Security System',
              icon_url: 'https://cdn-icons-png.flaticon.com/512/3556/3556198.png'
            }
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