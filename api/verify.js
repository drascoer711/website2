import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).send("Missing user_id parameter.");
  }

  // 1. Extract Advanced Telemetry, IP, Geo, and Headers
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "Unknown IP";
  const country = req.headers["x-vercel-ip-country"] || "Unknown Country";
  const region = req.headers["x-vercel-ip-country-region"] || "Unknown Region";
  const city = decodeURIComponent(req.headers["x-vercel-ip-city"] || "Unknown City");
  const userAgent = req.headers["user-agent"] || "Unknown Device";
  const acceptLanguage = req.headers["accept-language"] || "Unknown Language";
  const referer = req.headers["referer"] || "Direct / Unknown";
  
  const mobileHint = req.headers["sec-ch-ua-mobile"] === "?1" ? "Mobile" : "Desktop";
  const platformHint = req.headers["sec-ch-ua-platform"] ? req.headers["sec-ch-ua-platform"].replace(/"/g, "") : "Unknown OS";

  // Parse cookies for alt tracking
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(cookie => {
      const [key, ...v] = cookie.trim().split('=');
      return [key, decodeURIComponent(v.join('='))];
    })
  );

  const trackingCookieKey = cookies['alt_tracker_id'];
  let browserAltDetected = null;

  // 2. Safe Browser Cookie Cross-Referencing
  if (trackingCookieKey) {
    const browserRedisKey = `device_track:${trackingCookieKey}`;
    try {
      const previousBrowserUsers = await redis.smembers(browserRedisKey);
      if (Array.isArray(previousBrowserUsers) && previousBrowserUsers.length > 0) {
        const otherBrowserAlts = previousBrowserUsers.filter(id => String(id) !== String(user_id));
        if (otherBrowserAlts.length > 0) {
          browserAltDetected = otherBrowserAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
        }
      }
    } catch (err) {
      // Key likely doesn't exist yet, which is totally normal
    }

    try {
      await redis.sadd(browserRedisKey, user_id);
      await redis.expire(browserRedisKey, 60 * 60 * 24 * 90);
    } catch (err) {}
  }

  const newTrackingId = trackingCookieKey || Math.random().toString(36).substring(2) + Date.now().toString(36);
  if (!trackingCookieKey) {
    try {
      const browserRedisKey = `device_track:${newTrackingId}`;
      await redis.sadd(browserRedisKey, user_id);
      await redis.expire(browserRedisKey, 60 * 60 * 24 * 90);
    } catch (err) {}
  }

  // 3. Safe IP Cross-Referencing
  let ipAltWarning = null;
  if (ip !== "Unknown IP") {
    const ipRedisKey = `ip_track_v2:${ip}`;
    try {
      const previousIpUsers = await redis.smembers(ipRedisKey);
      if (Array.isArray(previousIpUsers) && previousIpUsers.length > 0) {
        const otherIpAlts = previousIpUsers.filter(id => String(id) !== String(user_id));
        if (otherIpAlts.length > 0) {
          ipAltWarning = otherIpAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
        }
      }
    } catch (err) {
      // Key doesn't exist yet on first visit, safe to ignore
    }

    try {
      await redis.sadd(ipRedisKey, user_id);
      await redis.expire(ipRedisKey, 60 * 60 * 24 * 30);
    } catch (err) {}
  }

  // 4. Fetch Discord User Details (Age & Public Flags)
  let accountAgeDays = "Unknown";
  let altFlags = "No alt heuristics triggered.";
  let badgeInfo = "None detected";
  const botToken = process.env.DISCORD_BOT_TOKEN; 

  if (botToken) {
    try {
      const discordResponse = await fetch(`https://discord.com/api/v10/users/${user_id}`, {
        headers: { Authorization: `Bot ${botToken}` }
      });
      if (discordResponse.ok) {
        const userData = await discordResponse.json();
        
        const snowflake = BigInt(user_id);
        const timestamp = Number((snowflake >> 22n) + 1420070400000n);
        const createdDate = new Date(timestamp);
        const ageTime = Date.now() - createdDate.getTime();
        accountAgeDays = Math.floor(ageTime / (1000 * 60 * 60 * 24));

        if (accountAgeDays < 7) {
          altFlags = `🚨 **High Risk Alt Indicator:** Account is only **${accountAgeDays} days old**`;
        } else {
          altFlags = `✅ Account age normal (**${accountAgeDays} days old**).`;
        }

        const flags = userData.public_flags || 0;
        const flagList = [];
        if (flags & (1 << 0)) flagList.push("Staff");
        if (flags & (1 << 1)) flagList.push("Partner");
        if (flags & (1 << 2)) flagList.push("HypeSquad Events");
        if (flags & (1 << 3)) flagList.push("Bug Hunter Level 1");
        if (flags & (1 << 6)) flagList.push("HypeSquad Bravery");
        if (flags & (1 << 7)) flagList.push("HypeSquad Brilliance");
        if (flags & (1 << 8)) flagList.push("HypeSquad Balance");
        if (flags & (1 << 9)) flagList.push("Early Supporter");
        if (flags & (1 << 14)) flagList.push("Bug Hunter Level 2");
        if (flags & (1 << 17)) flagList.push("Early Verified Bot Developer");
        
        if (flagList.length > 0) {
          badgeInfo = flagList.join(", ");
        }
      }
    } catch (err) {}
  }

  // 5. Send Rich Webhook Alert to Discord Staff Logs
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const fields = [
      {
        name: "🌐 Network & Location Diagnostics",
        value: `• **IP:** \`${ip}\`\n• **Location:** \`${city}, ${region}, ${country}\``,
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
        name: "🚨 SAME BROWSER / DEVICE ALT DETECTED!",
        value: `This browser session was previously used by: ${browserAltDetected}`,
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
      name: "💻 Device & Browser Telemetry",
      value: `• **Platform:** \`${platformHint} (${mobileHint})\`\n• **Language:** \`${acceptLanguage.split(',')[0]}\`\n• **Referrer:** \`${referer.substring(0, 80)}\``,
      inline: false
    });

    fields.push({
      name: "🛠️ Raw User-Agent Header",
      value: `\`\`\`text\n${userAgent.substring(0, 180)}\n\`\`\``,
      inline: false
    });

    const embed = {
      title: "🛡️ Advanced Telemetry & Device Fingerprint",
      description: `User <@${user_id}> (\`${user_id}\`) triggered the verification gate.`,
      color: (browserAltDetected || ipAltWarning || accountAgeDays < 7) ? 0xED4245 : 0x5865F2,
      fields: fields,
      timestamp: new Date().toISOString()
    };

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
      });
    } catch (err) {}
  }

  res.setHeader('Set-Cookie', `alt_tracker_id=${newTrackingId}; Path=/; Max-Age=${60*60*24*90}; HttpOnly; Secure; SameSite=Lax`);
  res.writeHead(302, { Location: "https://website2-umber-zeta.vercel.app/" });
  res.end();
}
