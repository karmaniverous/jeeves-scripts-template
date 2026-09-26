const fs = require('fs');
const path = require('path');
const USERS_FILE = path.join(__dirname, 'users.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');

let usersCache = null;
let channelsCache = null;

function loadUsers() {
  if (!usersCache) usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  return usersCache;
}

function loadChannels() {
  if (!channelsCache)
    channelsCache = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  return channelsCache;
}

function resolveSlackUserEmails(userIds) {
  if (!userIds) return [];
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const users = loadUsers();
  const emails = [];
  for (const id of ids) {
    const user = users[id];
    if (user && user.emails) {
      for (const e of user.emails) emails.push(e);
    }
  }
  return emails;
}

function resolveSlackChannelMeta(channelId) {
  if (!channelId || typeof channelId !== 'string') return {};
  const channels = loadChannels();
  const ch = channels[channelId];
  return ch && ch.metadata ? ch.metadata : {};
}

module.exports = { resolveSlackUserEmails, resolveSlackChannelMeta };
