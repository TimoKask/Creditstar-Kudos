require('dotenv').config();
const { App } = require('@slack/bolt');
const { Pool } = require('pg');

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize the app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Cache for user list to avoid rate limiting
let userListCache = null;
let userListCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Rate limiting for bot usage (prevent spam)
const userCooldowns = new Map();
const usersProcessing = new Set();
const COOLDOWN_MS = 3000; // 3 seconds between commands per user

// Authorized users who can view stats
const AUTHORIZED_STATS_USERS = process.env.AUTHORIZED_STATS_USERS
  ? process.env.AUTHORIZED_STATS_USERS.split(',').map(id => id.trim())
  : [];

// Initialize database table
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kudos (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sender_id VARCHAR(50) NOT NULL,
        recipient_ids TEXT[] NOT NULL,
        message TEXT NOT NULL,
        channel_id VARCHAR(50) NOT NULL
      )
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
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

// Record kudos in database
async function recordKudos(senderId, recipientIds, message, channelId) {
  try {
    await pool.query(
      'INSERT INTO kudos (sender_id, recipient_ids, message, channel_id) VALUES ($1, $2, $3, $4)',
      [senderId, recipientIds, message, channelId]
    );
    console.log('✅ Kudos recorded in database');
  } catch (error) {
    console.error('❌ Error recording kudos:', error);
  }
}

// Get kudos statistics
async function getKudosStats(monthsBack = 3) {
  try {
    const result = await pool.query(
      `SELECT sender_id, recipient_ids, timestamp 
       FROM kudos 
       WHERE timestamp >= NOW() - INTERVAL '${monthsBack} months'
       ORDER BY timestamp DESC`
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching kudos stats:', error);
    return [];
  }
}

// Shared handler function for text-based kudos commands
async function handleTextKudosCommand({ command, ack, say, respond, client }) {
  await ack();

  const userId = command.user_id;
  const now = Date.now();

  if (usersProcessing.has(userId)) {
    await respond({
      text: `⚠️ Please wait for your previous kudos to finish processing.`,
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
                text: `⚠️ Couldn't find user "@${username}". Make sure the username is correct.`,
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
            text: `❌ Error looking up user. Please try again.`,
            response_type: 'ephemeral',
          });
          return;
        }
      }
    }

    if (recipientUserIds.length === 0) {
      await respond({
        text: '⚠️ Please mention at least one user. Example: `/h5 @john great teamwork!`\n\nOr use `/kudos` (no arguments) to open a form!',
        response_type: 'ephemeral',
      });
      return;
    }

    if (!kudosMessage) {
      await respond({
        text: '⚠️ Please include a message with your kudos. Example: `/h5 @john great teamwork!`',
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

    // Record kudos in database
    const cleanRecipientIds = recipientUserIds.map(id => id.replace(/<@|>/g, ''));
    await recordKudos(userId, cleanRecipientIds, kudosMessage, command.channel_id);
  } catch (error) {
    console.error('Error handling kudos command:', error);
    await respond({
      text: '❌ Sorry, something went wrong while sending kudos. Please try again.',
      response_type: 'ephemeral',
    });
  } finally {
    usersProcessing.delete(userId);
  }
}

// Handle /h5 and /kudos commands
async function handleKudosCommand({ command, ack, client }) {
  const text = command.text.trim();

  if (text) {
    return handleTextKudosCommand({ command, ack, say: client.chat.postMessage.bind(client.chat), respond: async (msg) => {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: msg.text
        });
      }, client });
  }

  await ack();

  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'kudos_modal',
        title: {
          type: 'plain_text',
          text: 'Send Kudos 🙌'
        },
        submit: {
          type: 'plain_text',
          text: 'Send'
        },
        close: {
          type: 'plain_text',
          text: 'Cancel'
        },
        blocks: [
          {
            type: 'input',
            block_id: 'recipients_block',
            label: {
              type: 'plain_text',
              text: 'Who deserves kudos?'
            },
            element: {
              type: 'multi_users_select',
              action_id: 'recipients_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select one or more people'
              }
            }
          },
          {
            type: 'input',
            block_id: 'message_block',
            label: {
              type: 'plain_text',
              text: 'Your message'
            },
            element: {
              type: 'plain_text_input',
              action_id: 'message_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Great teamwork on the project!'
              }
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

// Handle modal submission
app.view('kudos_modal', async ({ ack, body, view, client }) => {
  await ack();

  const metadata = JSON.parse(view.private_metadata);
  const userId = metadata.user_id;
  const channelId = metadata.channel_id;
  const now = Date.now();

  if (usersProcessing.has(userId)) {
    console.log(`User ${userId} tried to submit kudos while already processing`);
    return;
  }

  const lastUsed = userCooldowns.get(userId);
  if (lastUsed && now - lastUsed < COOLDOWN_MS) {
    console.log(`User ${userId} hit rate limit`);
    return;
  }

  usersProcessing.add(userId);
  userCooldowns.set(userId, now);

  try {
    const recipients = view.state.values.recipients_block.recipients_select.selected_users;
    const message = view.state.values.message_block.message_input.value;

    if (!recipients || recipients.length === 0) {
      console.error('No recipients selected');
      return;
    }

    if (!message || message.trim() === '') {
      console.error('No message provided');
      return;
    }

    const recipientMentions = recipients.map(id => `<@${id}>`);
    let recipientsText;
    if (recipientMentions.length === 1) {
      recipientsText = recipientMentions[0];
    } else if (recipientMentions.length === 2) {
      recipientsText = `${recipientMentions[0]} and ${recipientMentions[1]}`;
    } else {
      const allButLast = recipientMentions.slice(0, -1).join(', ');
      const last = recipientMentions[recipientMentions.length - 1];
      recipientsText = `${allButLast}, and ${last}`;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `🙌 _*High Five* from <@${userId}>:_\n>*${recipientsText}*  _${message}_`
    });

    // Record kudos in database
    await recordKudos(userId, recipients, message, channelId);
  } catch (error) {
    console.error('Error handling modal submission:', error);
  } finally {
    usersProcessing.delete(userId);
  }
});

// Register both /h5 and /kudos commands
app.command('/h5', handleKudosCommand);
app.command('/kudos', handleKudosCommand);

// Handle /stats command
app.command('/stats', async ({ command, ack, respond, client }) => {
  await ack();

  const userId = command.user_id;

  if (AUTHORIZED_STATS_USERS.length > 0 && !AUTHORIZED_STATS_USERS.includes(userId)) {
    await respond({
      text: '🔒 Sorry, you don\'t have permission to view statistics. Contact your team administrator if you need access.',
      response_type: 'ephemeral'
    });
    return;
  }

  try {
    const recentKudos = await getKudosStats(3); // Last 3 months

    if (recentKudos.length === 0) {
      await respond({
        text: '📊 *Kudos Statistics (Last 3 Months)*\n\nNo kudos recorded yet. Be the first to give kudos!',
        response_type: 'ephemeral'
      });
      return;
    }

    // Count kudos given by each person
    const giverCounts = {};
    const receiverCounts = {};

    recentKudos.forEach(entry => {
      // Count givers
      giverCounts[entry.sender_id] = (giverCounts[entry.sender_id] || 0) + 1;

      // Count receivers
      entry.recipient_ids.forEach(recipientId => {
        receiverCounts[recipientId] = (receiverCounts[recipientId] || 0) + 1;
      });
    });

    // Sort and get top 5
    const topGivers = Object.entries(giverCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const topReceivers = Object.entries(receiverCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Fetch user names
    const userCache = {};
    const getUserName = async (userId) => {
      if (userCache[userId]) return userCache[userId];

      try {
        const userInfo = await client.users.info({ user: userId });
        const name = userInfo.user.real_name || userInfo.user.name;
        userCache[userId] = name;
        return name;
      } catch (error) {
        console.error(`Error fetching user ${userId}:`, error);
        return `<@${userId}>`;
      }
    };

    // Format top givers
    let giversText = '';
    for (let i = 0; i < topGivers.length; i++) {
      const [userId, count] = topGivers[i];
      const userName = await getUserName(userId);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      giversText += `${medal} *${userName}* - ${count} kudos given\n`;
    }

    // Format top receivers
    let receiversText = '';
    for (let i = 0; i < topReceivers.length; i++) {
      const [userId, count] = topReceivers[i];
      const userName = await getUserName(userId);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      receiversText += `${medal} *${userName}* - ${count} kudos received\n`;
    }

    // Send stats message
    await respond({
      text: `📊 *Kudos Statistics (Last 3 Months)*\n\n*Top 5 Kudos Givers:* 🎁\n${giversText}\n*Top 5 Kudos Receivers:* ⭐\n${receiversText}\n_Total kudos given: ${recentKudos.length}_`,
      response_type: 'ephemeral'
    });
  } catch (error) {
    console.error('Error generating stats:', error);
    await respond({
      text: '❌ Sorry, something went wrong while generating statistics.',
      response_type: 'ephemeral'
    });
  }
});

// Global error handler
app.error(async (error) => {
  console.error('App error:', error);
});

// Health check endpoint
if (app.receiver && app.receiver.router) {
  app.receiver.router.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });
}

// Start the app
(async () => {
  try {
    // Initialize database
    await initializeDatabase();

    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Slack Kudos Bot is running on port ${port}!`);
    console.log(`💡 Usage:`);
    console.log(`   - /kudos @user message          (quick text command)`);
    console.log(`   - /kudos                         (opens simple form)`);
    console.log(`   - /stats                         (view kudos leaderboards - private)`);
    console.log(`\n🔒 Stats Authorization:`);
    if (AUTHORIZED_STATS_USERS.length > 0) {
      console.log(`   ✅ Restricted to ${AUTHORIZED_STATS_USERS.length} authorized user(s)`);
    } else {
      console.log(`   ⚠️  No restrictions - anyone can view stats`);
      console.log(`   💡 Add AUTHORIZED_STATS_USERS to .env to restrict access`);
    }
    console.log(`\n💾 Database: Connected to PostgreSQL`);
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
})();