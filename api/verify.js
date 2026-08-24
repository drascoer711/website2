import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).send("Missing user_id parameter.");
  }

  // 1. Extract IP and browser cookies
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "Unknown IP";
  const country = req.headers["x-vercel-ip-country"] || "Unknown Country";
  const userAgent = req.headers["user-agent"] || "Unknown Device";

  // Parse cookies from request headers to look for previous alt trackers
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(cookie => {
      const [key, ...v] = cookie.trim().split('=');
      return [key, decodeURIComponent(v.join('='))];
    })
  );

  const trackingCookieKey = cookies['alt_tracker_id'];
  let browserAltDetected = null;

  // 2. Browser Cookie & Fingerprint Cross-Referencing
  if (trackingCookieKey) {
    const browserRedisKey = `device_track:${trackingCookieKey}`;
    try {
      let previousBrowserUsers = await redis.smembers(browserRedisKey) || [];
      await redis.sadd(browserRedisKey, user_id);
      await redis.expire(browserRedisKey, 60 * 60 * 24 * 90); // 90 days retention

      const otherBrowserAlts = previousBrowserUsers.filter(id => String(id) !== String(user_id));
      if (otherBrowserAlts.length > 0) {
        browserAltDetected = otherBrowserAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
      }
    } catch (err) {
      console.error("Browser tracking Redis error:", err);
    }
  }

  // Generate a unique tracking token for this browser if they don't have one
  const newTrackingId = trackingCookieKey || Math.random().toString(36).substring(2) + Date.now().toString(36);
  if (!trackingCookieKey) {
    try {
      await redis.sadd(`device_track:${newTrackingId}`, user_id);
      await redis.expire(`device_track:${newTrackingId}`, 60 * 60 * 24 * 90);
    } catch (err) {}
  }

  // 3. IP Cross-Referencing (Fallback backup)
  let ipAltWarning = null;
  if (ip !== "Unknown IP") {
    const ipRedisKey = `ip_track_v2:${ip}`;
    let previousIpUsers = [];
    try {
      previousIpUsers = await redis.smembers(ipRedisKey) || [];
      await redis.sadd(ipRedisKey, user_id);
      await redis.expire(ipRedisKey, 60 * 60 * 24 * 30);
    } catch (redisErr) {}

    const otherIpAlts = previousIpUsers.filter(id => String(id) !== String(user_id));
    if (otherIpAlts.length > 0) {
      ipAltWarning = otherIpAlts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
    }
  }

  // 4. Fetch Discord user details for age check
  let accountAgeDays = "Unknown";
  let altFlags = "No alt heuristics triggered.";
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
      }
    } catch (err) {}
  }

  // 5. Send Rich Webhook Alert to Discord Staff Logs
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const fields = [
      { name: "🌐 Network IP & Country", value: `\`${ip}\` (${country})`, inline: false },
      { name: "🕵️ Account Age Check", value: altFlags, inline: false }
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

  // Set the tracking cookie in the user's browser for 90 days before redirecting
  res.setHeader('Set-Cookie', `alt_tracker_id=${newTrackingId}; Path=/; Max-Age=${60*60*24*90}; HttpOnly; Secure; SameSite=Lax`);
  res.writeHead(302, { Location: "https://discord.com" });
  res.end();
}
