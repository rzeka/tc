import _ from 'lodash'
import angular from 'angular'
import axios from 'axios'
import moment from 'moment'
import electron from 'electron'
import settings from '../../lib/settings/settings'
import channels from '../../lib/channels'
import processMessage from '../../lib/transforms/process-message'

angular.module('tc').factory('messages', (
  $rootScope, irc, highlights, session) => {
  // =====================================================
  // Variables
  // =====================================================
  var ffzDonors = []
  var messageLimit = 125
  var messages = {}
  var lowerCaseUsername = settings.identity.username.toLowerCase()
  var throttledApplySlow = _.throttle(applyLate, 3000)
  var throttledApplyFast = _.throttle(applyLate, 100)

  // =====================================================
  // Setup
  // =====================================================
  fetchFfzDonors()
  setupIrcListeners()
  getMissingMessagesOnReconnect()
  deleteExtraMessagesOnAutoscrollEnabled()
  channels.channels.forEach(make)
  announceTwitter()
  channels.on('add', make)
  channels.on('remove', (channel) => delete messages[channel])

  // =====================================================
  // Public methods
  // =====================================================
  /** Shows a notification chat message in all channels */
  function addGlobalNotification (message) {
    settings.channels.forEach((channel) => addNotification(channel, message))
  }

  /** Adds a message with the 'notification' type */
  function addNotification (channel, message, golden) {
    const messageObject = {type: 'notification', message}
    if (golden) messageObject.golden = true
    addMessage(channel, messageObject)
  }

  /** Adds a message with the 'whisper' type */
  function addWhisper (from, to, message) {
    settings.channels.forEach((channel) => {
      addMessage(channel, {
        type: 'whisper',
        from: typeof from === 'string' ? from : from.username,
        user: typeof from === 'object' ? from : undefined,
        to,
        message
      })
    })
  }

  async function getMoreBacklog (channel) {
    return getBacklog(channel, earliestMessageTimestamp(channel))
  }

  // =====================================================
  // Private methods
  // =====================================================

  function announceTwitter () {
    const ver = electron.remote.app.getVersion()
    const channel = settings.channels[settings.selectedTabIndex]
    if (!channel) return
    addNotification(channel, `v${ver} - see twitter.com/tctwitch for changes.`)
  }

  function getMissingMessagesOnReconnect () {
    irc.on('disconnected', () => {
      irc.once('connected', () => {
        settings.channels.forEach(getMissingMessages)
      })
    })
  }

  function setupIrcListeners () {
    const listeners = getChatListeners()
    Object.keys(listeners).forEach((key) => {
      irc.on(key, listeners[key])
    })
  }

  function deleteExtraMessagesOnAutoscrollEnabled () {
    $rootScope.$watch(
      () => session.autoScroll,
      () => {
        if (session.autoScroll) {
          channels.channels.forEach((channel) => {
            const msgs = messages[channel]
            if (msgs.length > messageLimit) {
              msgs.splice(0, msgs.length - messageLimit)
            }
          })
        }
      }
    )
  }

  async function getBacklog (channel, before = Date.now(), after = 0, limit = 100) {
    const url = 'https://backlog.gettc.xyz/v1/' + channel
    try {
      const req = await axios(url, {params: {before, after, limit}})
      const backlog = req.data
      backlog.forEach((obj) => {
        obj.type = obj.user['message-type']
        if (obj.user.bits) {
          obj.type = 'cheer'
          obj.golden = true
        }
        obj.fromBacklog = true
        if (dontHaveMessage(channel, obj)) addUserMessage(channel, obj)
      })
      sortMessages(channel)
      if (session.autoScroll) trimMessages(channel)
      return true
    }
    catch (e) { return false }
  }

  async function getMissingMessages (channel) {
    const recent = mostRecentMessageTimestamp(channel)
    getBacklog(channel, Date.now(), recent)
  }

  function sortMessages (channel) {
    messages[channel].sort((a, b) => a.at - b.at)
  }

  function trimMessages (channel) {
    while (messages[channel].length > messageLimit) {
      messages[channel].shift()
    }
  }

  function dontHaveMessage (channel, obj) {
    window.messages = messages
    if (!messages[channel] || !obj.user || !obj.user.id) return true
    return !messages[channel].find(msg => {
      return msg.user ? msg.user.id === obj.user.id : false
    })
  }

  /**
   * Add a user message.
   * @property {string}  obj.type - 'action' or 'chat' or 'cheer'
   * @property {string}  obj.channel
   * @property {object}  obj.user - As provided by tmi.js
   * @property {string}  obj.message
   * @property {boolean} obj.fromBacklog
   * @property {number}  obj.at - Timestamp
   */
  function addUserMessage (channel, obj) {
    const {user, message} = obj
    const notSelf = user.username !== lowerCaseUsername

    if (settings.chat.ignored.indexOf(user.username) > -1) return
    if (user.special) user.special.reverse()
    if (!user['display-name']) user['display-name'] = user.username
    if (isFfzDonor(user.username)) user.ffz_donor = true
    if (highlights.test(message) && notSelf) obj.highlighted = true

    addMessage(channel, obj)
  }

  /**
   * Adds a message object to the message list
   * Not used directly, but via helpers
   * @param {string} channel
   * @param {object} messageObject
   */
  function addMessage (channel, messageObject) {
    const {type, fromBacklog} = messageObject
    if (channel.charAt(0) === '#') channel = channel.substring(1)
    if (!messageObject.at) messageObject.at = Date.now()

    const twitchEmotes = messageObject.user ? messageObject.user.emotes : null
    const msg = processMessage(messageObject, channel, twitchEmotes)

    messageObject.message = msg
    messages[channel].push(messageObject)

    if ((type === 'chat' || type === 'action') && !fromBacklog) {
      messages[channel].counter++
    }

    // Too many messages in memory
    if (session.autoScroll && !fromBacklog) {
      if (messages[channel].length > messageLimit) {
        messages[channel].shift()
      }
    }

    // TODO get rid of this completely, refactor somehow.
    // it makes this service UI aware and feels dirty, but it's
    // a massive performance boost to check and only $apply if
    // the message is for the currently selected channel
    if (channel === settings.channels[settings.selectedTabIndex]) {
      throttledApplyFast()
    }
    else if (messageObject.user) {
      throttledApplySlow()
    }
  }

  // =====================================================
  // Helper methods
  // =====================================================

  function earliestMessageTimestamp (channel) {
    const msgs = messages[channel]
    if (!msgs || !msgs.length) return Date.now()
    else return msgs[0].at
  }

  function mostRecentMessageTimestamp (channel) {
    const msgs = messages[channel]
    if (!msgs || !msgs.length) return 0
    else {
      const recentMessage = msgs.slice().reverse().find((msg) => {
        const t = msg.type
        return t === 'chat' || t === 'action' || t === 'cheer'
      })
      return recentMessage ? recentMessage.at : 0
    }
  }

  async function fetchFfzDonors () {
    const req = await axios('https://api.frankerfacez.com/v1/badge/supporter')
    const donors = req.data.users[3]
    ffzDonors.push(...donors)
  }

  function isFfzDonor (username) {
    return ffzDonors.indexOf(username) > -1
  }

  /** Mark previous messages from this user as deleted */
  function timeoutFromChat (channel, username) {
    channel = channel.substring(1)
    messages[channel].forEach((message) => {
      if (message.user && message.user.username === username) {
        message.deleted = true
      }
    })

    if (settings.appearance.hideTimeouts) {
      const arr = messages[channel]
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].deleted) arr.splice(i, 1)
      }
      applyLate()
    }
  }

  function applyLate () {
    setTimeout(() => $rootScope.$apply(), 0)
  }

  function make (channel) {
    messages[channel] = []
    messages[channel].counter = 0
    getMissingMessages(channel)
  }

  function capitalize (str) {
    return str.charAt(0).toUpperCase() + str.slice(1)
  }

  function getChatListeners () {
    return {
      // Users talking
      chat: (channel, user, message) => {
        addUserMessage(channel, {type: 'chat', user, message})
      },
      cheer: (channel, user, message) => {
        addUserMessage(channel, {type: 'cheer', user, message, golden: true})
      },
      action: (channel, user, message) => {
        addUserMessage(channel, {type: 'action', user, message})
      },
      whisper: (from, user, message, self) => {
        if (self) return
        if (from.startsWith('#')) from = from.substring(1)
        const me = capitalize(lowerCaseUsername)
        addWhisper(from, me, message)
      },

      // Moderators doing stuff
      ban: (channel, username, reason) => {
        const baseMsg = username + ' has been banned.'
        timeoutFromChat(channel, username)
        if (!settings.appearance.hideTimeouts) {
          const msg = baseMsg + (reason ? ` Reason: ${reason}.` : '')
          addNotification(channel, msg)
        }
      },
      timeout: (channel, username, reason, duration) => {
        timeoutFromChat(channel, username)
        if (!settings.appearance.hideTimeouts) {
          duration = Number(duration)
          const humanDur = moment.duration(duration, 'seconds').humanize()
          const baseMsg = username + ` has been timed out for ${humanDur}.`
          const msg = baseMsg + (reason ? ` Reason: ${reason}.` : '')
          addNotification(channel, msg)
        }
      },
      clearchat: (channel) => {
        const msg = 'Chat cleared by a moderator. (Prevented by Tc)'
        addNotification(channel, msg)
      },

      // Oh boy, network troubles
      connecting: () => addGlobalNotification('Connecting...'),
      connected: () => {
        settings.channels.forEach((channel) => {
          addNotification(channel, `Welcome to ${channel}'s chat.`)
        })
      },
      disconnected: () => {
        addGlobalNotification('Disconnected from the server.')
      },

      // Money!
      subscription: (channel, username, method, message) => {
        const planMap = {
          '1000': '$4.99',
          '2000': '$9.99',
          '3000': '$24.99'
        }
        const plan = planMap[method.plan] ? planMap[method.plan] : method.plan
        const noMsg = `${username} has subscribed with a ${plan} plan!`
        const msg = `${noMsg} "${message}"`
        addNotification(channel, message ? msg : noMsg, true)
      },
      resub: (channel, username, months, message) => {
        const noMsg = `${username} resubscribed ${months} months in a row!`
        const msg = noMsg + ' "' + message + '"'
        addNotification(channel, message ? msg : noMsg, true)
      },

      // Twitch's NOTICE
      // We're using a forked tmi.js because tmi.js's notice event is a based
      // on a whitelist. So it is not future-proof
      notification: (channel = '', msgId, message) => {
        channel = channel.substr(1)
        if (!channel || channel === '*') addGlobalNotification(message)
        else addNotification(channel, message)
      }
    }
  }

  return Object.assign(
    (channel) => messages[channel],
    {
      addWhisper,
      getMoreBacklog,
      addNotification,
      addGlobalNotification
    }
  )
})
