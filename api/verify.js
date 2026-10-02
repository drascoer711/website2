import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Helper for timeouts on fetch requests so your API doesn't hang
const fetchWithTimeout = async (url, options = {}, timeout = 3000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).send("Missing user_id parameter.");
  }

  // 1. Extract Advanced Telemetry
  const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "Unknown IP";
  const country = req.headers["x-vercel-ip-country"] || "Unknown Country";
  const region = req.headers["x-vercel-ip-country-region"] || "Unknown Region";
  const city = decodeURIComponent(req.headers["x-vercel-ip-city"] || "Unknown City");
  const userAgent = req.headers["user-agent"] || "Unknown Device";
  const acceptLanguage = req.headers["accept-language"] || "Unknown Language";
  const referer = req.headers["referer"] || "Direct / Unknown";
  
  const mobileHint = req.headers["sec-ch-ua-mobile"] === "?1" ? "Mobile" : "Desktop";
  const platformHint = req.headers["sec-ch-ua-platform"] ? req.headers["sec-ch-ua-platform"].replace(/"/g, "") : "Unknown OS";
  const cpuCores = req.headers["sec-ch-ua-arch"] || req.headers["sec-ch-ua-bitness"] || "Standard";

  // 2. IP Intelligence
  let vpnDetected = false;
  let vpnDetails = "None detected";
  let wifiProvider = "Unknown ISP / Provider";
  let connectionType = "Standard Residential";
  
  if (ip !== "Unknown IP" && ip !== "127.0.0.1" && ip !== "::1") {
    try {
      const ipCheckRes = await fetchWithTimeout(`https://ipwho.is/${ip}`);
      if (ipCheckRes.ok) {
        const ipData = await ipCheckRes.json();
        if (ipData.success && ipData.connection) {
          const { type, isp, org } = ipData.connection;
          wifiProvider = isp || org || "Unknown ISP";
          connectionType = type || "Standard";
          
          const vpnRegex = /vpn|proxy|hosting|ovh|digitalocean|aws|hetzner|cloudflare|m247|choopa|linode|vultr/i;
          if (type === "hosting" || type === "datacenter" || vpnRegex.test(isp + org)) {
            vpnDetected = true;
            vpnDetails = `ISP: ${isp || 'Unknown'} | Org: ${org \vert{}\vert{} 'Unknown'} \vert{} Type:${type || 'Hosting/VPN'}`;
          }
        }
      }
    } catch (err) {
      console.warn(`[IP API Error] Failed to fetch data for ${ip}:`, err.message);
    }
  }

  // 3. Cookie & Alt Tracking
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(cookie => {
      const [key, ...v] = cookie.trim().split('=');
      return [key, decodeURIComponent(v.join('='))];
    })
  );

  const trackingCookieKey = cookies['alt_tracker_id'];
  let browserAltDetected = null;
  let browserRingSize = 0;
  const newTrackingId = trackingCookieKey || Math.random().toString(36).substring(2) + Date.now().toString(36);
  const browserRedisKey = `device_track:${newTrackingId}`;

  try {
    const previousBrowserUsers = await redis.smembers(browserRedisKey);
    if (Array.isArray(previousBrowserUsers) && previousBrowserUsers.length > 0) {
      browserRingSize = previousBrowserUsers.length;
      const otherBrowserAlts = previousBrowserUsers.filter(id => String(id) !== String(user_id));
      if (otherBrowserAlts.length > 0) {
        browserAltDetected = otherBrowserAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
      }
    }
    
    // Fallback standard Redis commands (no pipeline to ensure max compatibility)
    await redis.sadd(browserRedisKey, user_id);
    await redis.expire(browserRedisKey, 60 * 60 * 24 * 90);
  } catch (err) {
    console.error("[Redis Error] Browser tracking failed:", err.message);
  }

  // 4. IP Alt Tracking
  let ipAltWarning = null;
  let ipRingSize = 0;
  if (ip !== "Unknown IP") {
    const ipRedisKey = `ip_track_v2:${ip}`;
    try {
      const previousIpUsers = await redis.smembers(ipRedisKey);
      if (Array.isArray(previousIpUsers) && previousIpUsers.length > 0) {
        ipRingSize = previousIpUsers.length;
        const otherIpAlts = previousIpUsers.filter(id => String(id) !== String(user_id));
        if (otherIpAlts.length > 0) {
          ipAltWarning = otherIpAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
        }
      }
      
      await redis.sadd(ipRedisKey, user_id);
      await redis.expire(ipRedisKey, 60 * 60 * 24 * 30);
    } catch (err) {
      console.error("[Redis Error] IP tracking failed:", err.message);
    }
  }

  // 5. Discord User Details
  let accountAgeDays = "Unknown";
  let altFlags = "No alt heuristics triggered.";
  let badgeInfo = "None detected";
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
          1: "Staff", 2: "Partner", 4: "HypeSquad Events", 8: "Bug Hunter Level 1",
          64: "HypeSquad Bravery", 128: "HypeSquad Brilliance", 256: "HypeSquad Balance",
          512: "Early Supporter", 16384: "Bug Hunter Level 2", 131072: "Early Verified Bot Developer"
        };
        
        const flagList = Object.entries(flagMap)
          .filter(([bit]) => flags & Number(bit))
          .map(([, name]) => name);
          
        if (flagList.length > 0) badgeInfo = flagList.join(", ");
      }
    } catch (err) {
      console.warn(`[Discord API Error] Failed fetching user ${user_id}:`, err.message);
    }
  }

  // 6. Webhook Execution
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const fields = [
      {
        name: "🌐 Network, ISP & Location Diagnostics",
        value: `• **IP:** \`${ip}\`\n• **WiFi/ISP:** \`${wifiProvider}\`\n• **Type:** \`${connectionType}\`\n• **Location:** \`${city}, ${region}, ${country}\`\n• **Network Ring Size:** \`${ipRingSize} accounts linked\``,
        inline: false
      },
      {
        name: "🛡️ VPN / Proxy Detection",
        value: vpnDetected ? `🚨 **VPN/Hosting Detected!**\n\`${vpnDetails}\`` : `✅ Residential / Clean Network`,
        inline: false
      },
      {
        name: "🕵️ Account Age & Badges",
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
        name: "🔗 Shared Network IP Match",
        value: `Same IP used by: ${ipAltWarning}`,
        inline: false
      });
    }

    fields.push({
      name: "💻 Hardware & Browser Telemetry",
      value: `• **Platform:** \`${platformHint} (${mobileHint})\`\n• **CPU:** \`${cpuCores}\`\n• **Lang:** \`${acceptLanguage.split(',')[0]}\``,
      inline: false
    });

    try {
      await fetchWithTimeout(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "🛡️ Advanced Telemetry & Device Fingerprint",
            description: `User <@${user_id}> (\`${user_id}\`) triggered the verification gate.`,
            thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
            color: (vpnDetected || browserAltDetected || ipAltWarning || accountAgeDays < 7) ? 0xED4245 : 0x5865F2,
            fields: fields,
            timestamp: new Date().toISOString()
          }]
        })
      });
    } catch (err) {
      console.error("[Webhook Error] Failed to send embed:", err.message);
    }
  }

  // Final Response & Redirect
  res.setHeader('Set-Cookie', `alt_tracker_id=${newTrackingId}; Path=/; Max-Age=${60*60*24*90}; HttpOnly; Secure; SameSite=Lax`);
  res.writeHead(302, { Location: "https://website2-umber-zeta.vercel.app/" });
  res.end();
}
