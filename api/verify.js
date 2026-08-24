import { Redis } from '@upstash/redis';

// Initialize Upstash Redis client using environment variables
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).send("Missing user_id parameter.");
  }

  // 1. Extract IP and telemetry from Vercel edge headers
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "Unknown IP";
  const country = req.headers["x-vercel-ip-country"] || "Unknown Country";
  const userAgent = req.headers["user-agent"] || "Unknown Device";

  let accountAgeDays = "Unknown";
  let createdAtFormatted = "Unknown";
  let altFlags = "No alt heuristics triggered via API lookup.";

  // 2. Fetch user details from Discord API
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
        
        createdAtFormatted = createdDate.toISOString().split('T')[0];
        const ageTime = Date.now() - createdDate.getTime();
        accountAgeDays = Math.floor(ageTime / (1000 * 60 * 60 * 24));

        if (accountAgeDays < 7) {
          altFlags = `🚨 **High Risk Alt Indicator:** Account is only **${accountAgeDays} days old** (Created: ${createdAtFormatted})`;
        } else if (accountAgeDays < 30) {
          altFlags = `⚠️ **Moderate Risk:** Account is **${accountAgeDays} days old**`;
        } else {
          altFlags = `✅ Account age normal (**${accountAgeDays} days old**). No immediate age flags.`;
        }
      }
    } catch (err) {
      console.error("Failed to fetch Discord user telemetry:", err);
    }
  }

  // 3. IP Cross-Referencing using a fresh key prefix to avoid type conflicts
  let ipAltWarning = null;
  if (ip !== "Unknown IP") {
    const redisKey = `ip_track_v2:${ip}`;
    let previousUsers = [];

    try {
      previousUsers = await redis.smembers(redisKey) || [];
      await redis.sadd(redisKey, user_id);
      await redis.expire(redisKey, 60 * 60 * 24 * 30);
    } catch (redisErr) {
      console.error("Redis error handled safely:", redisErr);
    }

    const otherAccounts = previousUsers.filter(id => id !== user_id);

    if (otherAccounts.length > 0) {
      const formattedAlts = otherAccounts.map(id => `<@${id}> (\`${id}\`)`).join(", ");
      ipAltWarning = `🚨 **IP Match Detected!** This IP address was previously used by: ${formattedAlts}`;
    }
  }

  // 4. Format Discord Webhook payload
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (webhookUrl) {
    const fields = [
      {
        name: "🌐 Network IP & Geo-Location",
        value: `• **IP Address:** \`${ip}\`\n• **Country Origin:** \`${country}\``,
        inline: false
      },
      {
        name: "🕵️ Alt Account & Age Diagnostics",
        value: altFlags,
        inline: false
      }
    ];

    if (ipAltWarning) {
      fields.push({
        name: "🔗 Shared Network / Alt Alert",
        value: ipAltWarning,
        inline: false
      });
    }

    fields.push({
      name: "💻 Client Device Header",
      value: `\`\`\`text\n${userAgent.substring(0, 200)}\n\`\`\``,
      inline: false
    });

    const embed = {
      title: "🛡️ Web Portal Authentication & Telemetry",
      description: `User <@${user_id}> (\`${user_id}\`) opened the verification link.`,
      color: (accountAgeDays < 7 || ipAltWarning) ? 0xED4245 : 0x5865F2,
      fields: fields,
      timestamp: new Date().toISOString()
    };

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] })
      });
    } catch (err) {
      console.error("Failed to push Discord webhook:", err);
    }
  }

  res.writeHead(302, { Location: "https://discord.com" });
  res.end();
}
