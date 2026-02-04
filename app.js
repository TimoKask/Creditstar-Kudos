require('dotenv').config();
const { App } = require('@slack/bolt');
const initSqlJs = require('sql.js');
const fs = require('fs').promises;
const path = require('path');

// Database file path - use DATA_DIR env var for Railway volume
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = path.join(dataDir, 'kudos.db');
let db = null;

// Initialize the app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Cache for user list
let userListCache = null;
let userListCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000;

// Rate limiting
const userCooldowns = new Map();
const usersProcessing = new Set();
const COOLDOWN_MS = 3000;

// Authorized users
const AUTHORIZED_STATS_USERS = process.env.AUTHORIZED_STATS_USERS
  ? process.env.AUTHORIZED_STATS_USERS.split(',').map(id => id.trim())
  : [];

// Initialize database
async function initializeDatabase() {
  try {
    const SQL = await initSqlJs();

    // Ensure data directory exists (for Railway volume)
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }

    // Try to load existing database
    let buffer;
    try {
      buffer = await fs.readFile(dbPath);
      db = new SQL.Database(buffer);
      console.log(`✅ Loaded existing database from ${dbPath}`);
    } catch (err) {
      // Create new database
      db = new SQL.Database();
      console.log(`✅ Created new database at ${dbPath}`);
    }

    // Create table if it doesn't exist
    db.run(`
        CREATE TABLE IF NOT EXISTS kudos (
                                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                                             timestamp TEXT DEFAULT (datetime('now')),
            sender_id TEXT NOT NULL,
            recipient_ids TEXT NOT NULL,
            message TEXT NOT NULL,
            channel_id TEXT NOT NULL
            )
    `);

    // Save to disk
    await saveDatabase();

    // Log entry count
    const count = db.exec('SELECT COUNT(*) as count FROM kudos')[0]?.values[0][0] || 0;
    console.log(`📊 Total kudos entries: ${count}`);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  }
}

// Save database to disk
async function saveDatabase() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    await fs.writeFile(dbPath, buffer);
  } catch (error) {
    console.error('Error saving database:', error);
  }
}

async function getUserList(client) {
  const now = Date.now();
  if (userListCache && userListCacheTime && now - userListCacheTime < CACHE_DURATION) {
    return userListCache;
  }
  const result = await client.users.list();
  userListCache = result;
  userListCacheTime = now;
  return result;
}

// Record kudos
async function recordKudos(senderId, recipientIds, message, channelId) {
  try {
    db.run(
      'INSERT INTO kudos (sender_id, recipient_ids, message, channel_id) VALUES (?, ?, ?, ?)',
      [senderId, JSON.stringify(recipientIds), message, channelId]
    );
    await saveDatabase();
    console.log('✅ Kudos recorded in database');
  } catch (error) {
    console.error('❌ Error recording kudos:', error);
  }
}

// Get stats
function getKudosStats(monthsBack = 3) {
  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - monthsBack);
    const isoDate = threeMonthsAgo.toISOString();

    const stmt = db.prepare(
      `SELECT sender_id, recipient_ids, timestamp
       FROM kudos
       WHERE timestamp >= ?
       ORDER BY timestamp DESC`
    );

    stmt.bind([isoDate]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      row.recipient_ids = JSON.parse(row.recipient_ids);
      rows.push(row);
    }
    stmt.free();

    return rows;
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    return [];
  }
}

// Text kudos handler (sends directly without modal)
async function handleTextKudosCommand({ command, ack, say, respond, client }) {
  await ack();

  const userId = command.user_id;
  const now = Date.now();

  if (usersProcessing.has(userId)) {
    await respond({
      text: '⚠️ Please wait for your previous kudos to finish processing.',
      response_type: 'ephemeral',
    });
    return;
  }

  const lastUsed = userCooldowns.get(userId);
  if (lastUsed && now - lastUsed < COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
    await respond({
      text: `⚠️ Please wait ${remainingSeconds} second(s) before sending another kudos.`,
      response_type: 'ephemeral',
    });
    return;
  }

  usersProcessing.add(userId);
  userCooldowns.set(userId, now);

  try {
    const text = command.text.trim();
    let recipientUserIds = [];
    let kudosMessage = '';

    const properMentionMatches = text.matchAll(/<@([A-Z0-9]+)(\|[^>]+)?>/g);
    const properMatches = Array.from(properMentionMatches);

    if (properMatches.length > 0) {
      recipientUserIds = properMatches.map((match) => match[0]);
      const lastMatch = properMatches[properMatches.length - 1];
      const lastMentionEnd = text.lastIndexOf(lastMatch[0]) + lastMatch[0].length;
      kudosMessage = text.substring(lastMentionEnd).trim();
    } else {
      const plainMentionMatches = text.matchAll(/@(\w+)/g);
      const plainMatches = Array.from(plainMentionMatches);

      if (plainMatches.length > 0) {
        try {
          const result = await getUserList(client);

          for (const match of plainMatches) {
            const username = match[1];
            const user = result.members.find(
              (member) =>
                member.name === username ||
                member.profile.display_name === username
            );

            if (user) {
              recipientUserIds.push(`<@${user.id}>`);
            } else {
              await respond({
                text: `⚠️ Couldn't find user "@${username}".`,
                response_type: 'ephemeral',
              });
              return;
            }
          }

          const lastMatch = plainMatches[plainMatches.length - 1];
          const lastMentionEnd = text.lastIndexOf(lastMatch[0]) + lastMatch[0].length;
          kudosMessage = text.substring(lastMentionEnd).trim();
        } catch (error) {
          console.error('Error looking up user:', error);
          await respond({
            text: '❌ Error looking up user.',
            response_type: 'ephemeral',
          });
          return;
        }
      }
    }

    if (recipientUserIds.length === 0) {
      await respond({
        text: '⚠️ Please mention at least one user.',
        response_type: 'ephemeral',
      });
      return;
    }

    if (!kudosMessage) {
      await respond({
        text: '⚠️ Please include a message.',
        response_type: 'ephemeral',
      });
      return;
    }

    let recipientsText;
    if (recipientUserIds.length === 1) {
      recipientsText = recipientUserIds[0];
    } else if (recipientUserIds.length === 2) {
      recipientsText = `${recipientUserIds[0]} and ${recipientUserIds[1]}`;
    } else {
      const allButLast = recipientUserIds.slice(0, -1).join(', ');
      const last = recipientUserIds[recipientUserIds.length - 1];
      recipientsText = `${allButLast}, and ${last}`;
    }

    await say({
      text: `🙌 _*High Five* from <@${userId}>:_\n>*${recipientsText}*  _${kudosMessage}_`,
      channel: command.channel_id,
    });

    const cleanRecipientIds = recipientUserIds.map(id => id.replace(/<@|>/g, ''));
    await recordKudos(userId, cleanRecipientIds, kudosMessage, command.channel_id);
  } catch (error) {
    console.error('Error handling kudos:', error);
    await respond({
      text: '❌ Error sending kudos.',
      response_type: 'ephemeral',
    });
  } finally {
    usersProcessing.delete(userId);
  }
}

// Modal handler - supports prefilling users from command text
async function handleKudosCommand({ command, ack, client }) {
  const text = command.text.trim();

  let mentionedUsers = [];
  let prefillMessage = '';

  // Check for formatted mentions first: <@U12345>
  const formattedMatch = text.match(/<@([A-Z0-9]+)(\|[^>]+)?>/g);

  if (formattedMatch && formattedMatch.length > 0) {
    mentionedUsers = formattedMatch.map(m => m.match(/<@([A-Z0-9]+)/)[1]);
    const lastMention = formattedMatch[formattedMatch.length - 1];
    const lastIndex = text.lastIndexOf(lastMention) + lastMention.length;
    prefillMessage = text.substring(lastIndex).trim();
  } else {
    // Check for plain @username mentions
    const plainMatch = text.match(/@(\w+)/g);

    if (plainMatch && plainMatch.length > 0) {
      try {
        const result = await getUserList(client);

        for (const match of plainMatch) {
          const username = match.substring(1); // Remove @
          const user = result.members.find(
            (member) =>
              member.name === username ||
              member.profile.display_name === username ||
              member.profile.display_name_normalized === username
          );

          if (user) {
            mentionedUsers.push(user.id);
          }
        }

        // Extract message after last @mention
        const lastMatch = plainMatch[plainMatch.length - 1];
        const lastIndex = text.lastIndexOf(lastMatch) + lastMatch.length;
        prefillMessage = text.substring(lastIndex).trim();
      } catch (error) {
        console.error('Error looking up users:', error);
      }
    }
  }

  // If we have users AND a message, send directly (no modal)
  if (mentionedUsers.length > 0 && prefillMessage) {
    return handleTextKudosCommand({
      command,
      ack,
      say: client.chat.postMessage.bind(client.chat),
      respond: async (msg) => {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: msg.text
        });
      },
      client
    });
  }

  // Otherwise open modal (with pre-filled users if provided)
  await ack();

  try {
    const userSelectElement = {
      type: 'multi_users_select',
      action_id: 'recipients_select',
      placeholder: { type: 'plain_text', text: 'Select people' }
    };

    // Pre-fill users if mentioned
    if (mentionedUsers.length > 0) {
      userSelectElement.initial_users = mentionedUsers;
    }

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'kudos_modal',
        title: { type: 'plain_text', text: 'Send Kudos 🙌' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'recipients_block',
            label: { type: 'plain_text', text: 'Who deserves kudos?' },
            element: userSelectElement
          },
          {
            type: 'input',
            block_id: 'message_block',
            label: { type: 'plain_text', text: 'Your message' },
            element: {
              type: 'plain_text_input',
              action_id: 'message_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Great teamwork!' }
            }
          }
        ],
        private_metadata: JSON.stringify({
          channel_id: command.channel_id,
          user_id: command.user_id
        })
      }
    });
  } catch (error) {
    console.error('Error opening modal:', error);
  }
}

// Modal submission
app.view('kudos_modal', async ({ ack, body, view, client }) => {
  await ack();

  const metadata = JSON.parse(view.private_metadata);
  const userId = metadata.user_id;
  const channelId = metadata.channel_id;

  try {
    const recipients = view.state.values.recipients_block.recipients_select.selected_users;
    const message = view.state.values.message_block.message_input.value;

    if (!recipients || !message) return;

    const recipientMentions = recipients.map(id => `<@${id}>`);
    let recipientsText;
    if (recipientMentions.length === 1) {
      recipientsText = recipientMentions[0];
    } else if (recipientMentions.length === 2) {
      recipientsText = `${recipientMentions[0]} and ${recipientMentions[1]}`;
    } else {
      const allButLast = recipientMentions.slice(0, -1).join(', ');
      recipientsText = `${allButLast}, and ${recipientMentions[recipientMentions.length - 1]}`;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `🙌 _*High Five* from <@${userId}>:_\n>*${recipientsText}*  _${message}_`
    });

    await recordKudos(userId, recipients, message, channelId);
  } catch (error) {
    console.error('Error in modal:', error);
  }
});

// Commands
app.command('/h5', handleKudosCommand);
app.command('/kudos', handleKudosCommand);

// Stats
app.command('/stats', async ({ command, ack, respond, client }) => {
  await ack();

  const userId = command.user_id;

  if (AUTHORIZED_STATS_USERS.length > 0 && !AUTHORIZED_STATS_USERS.includes(userId)) {
    await respond({
      text: '🔒 No permission to view stats.',
      response_type: 'ephemeral'
    });
    return;
  }

  try {
    const recentKudos = getKudosStats(3);

    if (recentKudos.length === 0) {
      await respond({
        text: '📊 *Kudos Statistics (Last 3 Months)*\n\nNo kudos yet!',
        response_type: 'ephemeral'
      });
      return;
    }

    const giverCounts = {};
    const receiverCounts = {};

    recentKudos.forEach(entry => {
      giverCounts[entry.sender_id] = (giverCounts[entry.sender_id] || 0) + 1;
      entry.recipient_ids.forEach(recipientId => {
        receiverCounts[recipientId] = (receiverCounts[recipientId] || 0) + 1;
      });
    });

    const topGivers = Object.entries(giverCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topReceivers = Object.entries(receiverCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const userCache = {};
    const getUserName = async (userId) => {
      if (userCache[userId]) return userCache[userId];
      try {
        const userInfo = await client.users.info({ user: userId });
        const name = userInfo.user.real_name || userInfo.user.name;
        userCache[userId] = name;
        return name;
      } catch (error) {
        return `<@${userId}>`;
      }
    };

    let giversText = '';
    for (let i = 0; i < topGivers.length; i++) {
      const [uid, count] = topGivers[i];
      const name = await getUserName(uid);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      giversText += `${medal} *${name}* - ${count} kudos given\n`;
    }

    let receiversText = '';
    for (let i = 0; i < topReceivers.length; i++) {
      const [uid, count] = topReceivers[i];
      const name = await getUserName(uid);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      receiversText += `${medal} *${name}* - ${count} kudos received\n`;
    }

    await respond({
      text: `📊 *Kudos Statistics (Last 3 Months)*\n\n*Top 5 Kudos Givers:* 🎁\n${giversText}\n*Top 5 Kudos Receivers:* ⭐\n${receiversText}\n_Total kudos: ${recentKudos.length}_`,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error generating stats:', error);
    await respond({
      text: '❌ Error generating stats.',
      response_type: 'ephemeral'
    });
  }
});

// Error handler
app.error(async (error) => {
  console.error('App error:', error);
});

// Start
(async () => {
  try {
    await initializeDatabase();

    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Slack Kudos Bot is running on port ${port}!`);
    console.log(`💾 Database: ${dbPath}`);
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
})();