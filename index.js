
const dotenv = require("dotenv");

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");

/* ============================================
   CONFIGURATION
============================================ */

const ENV_FILE = path.join(__dirname, ".env");

const GATEWAY_URL =
    "wss://gateway.discord.gg/?v=10&encoding=json";

const API =
    "https://discord.com/api/v10";

let config = {};
let botConfigs = new Map();
const bots = new Map();

let shuttingDown = false;

/* ============================================
   LOG
============================================ */

function log(message) {
    console.log(
        `[${new Date().toLocaleTimeString()}] ${message}`
    );
}

function normalizeBotId(id) {
    return String(id).padStart(2, "0");
}

function validId(id) {
    return /^\d+$/.test(String(id));
}

/* ============================================
   ENVIRONMENT
============================================ */

function loadEnv() {
    const parsed = process.env;

    const nextConfig = {
        guildId: parsed.GUILD_ID || "",
        status: parsed.STATUS || "online",
        selfMute: parsed.SELF_MUTE !== "false",
        selfDeaf: parsed.SELF_DEAF !== "false"
    };

    if (!validId(nextConfig.guildId)) {
        throw new Error("Invalid or missing GUILD_ID environment variable.");
    }

    const nextBots = new Map();

    for (const [key, value] of Object.entries(parsed)) {
        const match = key.match(/^BOT_(\d+)_TOKEN$/);

        if (!match || !value?.trim()) continue;

        const id = normalizeBotId(match[1]);

        const channelId =
            parsed[`BOT_${match[1]}_CHANNEL_ID`] || "";

        if (!validId(channelId)) {
            log(`Bot ${id}: invalid or missing channel ID.`);
            continue;
        }

        nextBots.set(id, {
            id,
            token: value.trim(),
            channelId: String(channelId).trim()
        });
    }

    config = nextConfig;
    botConfigs = nextBots;

    return nextBots;
}


/* ============================================
   BOT CONNECTION CLASS
============================================ */

class BotConnection {

    constructor(botConfig) {
        this.id = botConfig.id;
        this.token = botConfig.token;
        this.channelId = botConfig.channelId;

        this.ws = null;
        this.botUser = null;

        this.status = "stopped";

        this.heartbeatTimer = null;
        this.heartbeatInterval = 0;
        this.reconnectTimer = null;
        this.voiceRejoinTimer = null;

        this.reconnectDelay = 1000;

        this.connecting = false;
        this.stopping = false;

        this.suppressReconnect = false;
        this.restartPending = false;
    }

    /* ========================================
       LOG
    ======================================== */

    log(message) {
        log(`[BOT ${this.id}] ${message}`);
    }

    /* ========================================
       STATUS
    ======================================== */

    setStatus(status) {
        this.status = status;
    }

    /* ========================================
       TOKEN VALIDATION
    ======================================== */

    async checkToken() {
        const response = await fetch(
            `${API}/users/@me`,
            {
                headers: {
                    Authorization: `${this.token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Token validation failed: HTTP ${response.status}`
            );
        }

        this.botUser = await response.json();

        this.log(
            `Authenticated as ${this.botUser.username} (${this.botUser.id})`
        );
    }

    /* ========================================
       START
    ======================================== */

    async start() {
        if (
            this.ws ||
            this.connecting ||
            this.stopping ||
            shuttingDown
        ) {
            return;
        }

        try {
            this.setStatus("starting");

            await this.checkToken();

            if (this.stopping || shuttingDown) return;

            this.reconnectDelay = 1000;

            this.connectGateway();

        } catch (error) {
            this.log(`Start failed: ${error.message}`);



            this.setStatus("retrying");

            this.scheduleStartRetry();
        }
    }

    /* ========================================
       HEARTBEAT
    ======================================== */

    startHeartbeat(interval) {
        this.stopHeartbeat();

        this.heartbeatInterval = interval;

        const initialDelay = Math.random() * interval;

        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTick();
        }, initialDelay);
    }

    heartbeatTick() {
        if (
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        ) {
            this.stopHeartbeat();
            return;
        }

        this.sendHeartbeat();

        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTick();
        }, this.heartbeatInterval);
    }

    sendHeartbeat() {
        if (
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        try {
            this.ws.send(
                JSON.stringify({
                    op: 1,
                    d: null
                })
            );
        } catch (error) {
            this.log(
                `Heartbeat error: ${error.message}`
            );
        }
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        this.heartbeatInterval = 0;
    }

    /* ========================================
       IDENTIFY
    ======================================== */

    identify() {
        if (
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                op: 2,

                d: {
                    token: this.token,
                    intents: 129,

                    properties: {
                        os: process.platform,
                        browser: "discord.js",
                        device: "discord.js"
                    },

                    presence: {
                        status: config.status,
                        afk: false
                    }
                }
            })
        );
    }

    /* ========================================
       JOIN VOICE
    ======================================== */

    joinVoice() {
        if (
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        this.log(
            `Joining channel ${this.channelId}...`
        );

        this.ws.send(
            JSON.stringify({
                op: 4,

                d: {
                    guild_id: config.guildId,
                    channel_id: this.channelId,

                    self_mute: config.selfMute,
                    self_deaf: config.selfDeaf
                }
            })
        );

        this.setStatus("joining");
    }

    changeChannel(newChannelId) {
        newChannelId = String(newChannelId);

        if (!validId(newChannelId)) {
            this.log("Invalid channel ID.");
            return;
        }

        this.clearVoiceRejoinTimer();

        this.channelId = newChannelId;

        this.log(
            `Changing channel to ${newChannelId}`
        );

        if (
            this.ws &&
            this.ws.readyState === WebSocket.OPEN
        ) {
            this.joinVoice();
        }
    }

    /* ========================================
       GATEWAY EVENTS
    ======================================== */

    handleGatewayEvent(event) {

        // HELLO
        if (event.op === 10) {
            const interval = event.d?.heartbeat_interval;

            if (!interval) {
                throw new Error(
                    "Missing heartbeat interval."
                );
            }

            this.startHeartbeat(interval);
            this.identify();

            return;
        }

        // HEARTBEAT REQUEST
        if (event.op === 1) {
            this.sendHeartbeat();
            return;
        }

        // HEARTBEAT ACK
        if (event.op === 11) {
            return;
        }

        // INVALID SESSION
        if (event.op === 9) {
            this.log("Invalid session received.");

            setTimeout(() => {
                if (
                    !this.stopping &&
                    this.ws &&
                    this.ws.readyState === WebSocket.OPEN
                ) {
                    this.identify();
                }
            }, 1000);

            return;
        }

        // DISPATCH
        if (event.op !== 0) return;

        switch (event.t) {

            case "READY":

                this.botUser = event.d.user;

                this.log("Gateway READY.");

                this.setStatus("ready");

                this.joinVoice();

                break;

            case "VOICE_STATE_UPDATE":

                this.handleVoiceStateUpdate(event.d);

                break;

            case "VOICE_SERVER_UPDATE":

                this.log("VOICE_SERVER_UPDATE received.");

                break;

            default:
                break;
        }
    }

    /* ========================================
       VOICE STATE
    ======================================== */

    clearVoiceRejoinTimer() {
        if (this.voiceRejoinTimer) {
            clearTimeout(this.voiceRejoinTimer);
            this.voiceRejoinTimer = null;
        }
    }

    scheduleVoiceRejoin() {
        if (
            this.stopping ||
            shuttingDown ||
            this.voiceRejoinTimer
        ) {
            return;
        }

        this.log("Voice disconnected. Rejoining in 3 seconds...");

        this.voiceRejoinTimer = setTimeout(() => {
            this.voiceRejoinTimer = null;

            if (
                this.stopping ||
                shuttingDown ||
                !this.ws ||
                this.ws.readyState !== WebSocket.OPEN
            ) {
                return;
            }

            this.joinVoice();
        }, 100);
    }

    handleVoiceStateUpdate(data) {
        if (
            !this.botUser ||
            data.guild_id !== config.guildId ||
            data.user_id !== this.botUser.id
        ) {
            return;
        }

        // Bot successfully joined its assigned channel
        if (data.channel_id === this.channelId) {
            this.clearVoiceRejoinTimer();

            this.log(
                `Voice state confirmed: ${this.channelId}`
            );

            this.setStatus("connected");
            return;
        }

        // Bot disconnected from voice
        if (!data.channel_id) {
            this.log("Bot disconnected from voice.");

            this.setStatus("disconnected");
            this.scheduleVoiceRejoin();

            return;
        }

        // Bot was moved to another channel.
        // Respect the server moderator's move.
        this.clearVoiceRejoinTimer();

        this.log(
            `Bot moved to another channel: ${data.channel_id}`
        );

        this.setStatus("moved");
    }

    /* ========================================
       TIMER MANAGEMENT
    ======================================== */

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /* ========================================
       CONNECT GATEWAY
    ======================================== */

    connectGateway() {
        if (
            this.stopping ||
            shuttingDown ||
            this.connecting
        ) {
            return;
        }

        if (
            this.ws &&
            (
                this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING
            )
        ) {
            return;
        }

        this.connecting = true;

        this.setStatus("connecting");

        this.log("Connecting to Gateway...");

        const socket = new WebSocket(GATEWAY_URL, {
            perMessageDeflate: false
        });

        this.ws = socket;

        socket.on("open", () => {
            if (this.ws !== socket) return;

            this.connecting = false;
            this.reconnectDelay = 1000;

            this.setStatus("connected");

            this.log("WebSocket opened.");
        });

        socket.on("message", data => {
            if (this.ws !== socket) return;

            try {
                const event = JSON.parse(data.toString());

                this.handleGatewayEvent(event);

            } catch (error) {
                this.log(
                    `Gateway message error: ${error.message}`
                );
            }
        });

        socket.on("error", error => {
            if (this.ws !== socket) return;

            this.connecting = false;

            this.log(
                `WebSocket error: ${error.message}`
            );

            this.setStatus("error");
        });

        socket.on("close", (code, reason) => {
            if (this.ws !== socket) return;

            this.ws = null;
            this.connecting = false;

            this.stopHeartbeat();

            this.log(
                `WebSocket closed: code=${code}, reason=${reason.toString() || "none"}`
            );

            if (this.suppressReconnect) {
                this.suppressReconnect = false;

                if (this.restartPending) {
                    this.restartPending = false;

                    if (!this.stopping && !shuttingDown) {
                        this.start();
                    }
                }

                return;
            }

            if (this.stopping || shuttingDown) return;

            this.setStatus("disconnected");

            this.scheduleReconnect();
        });
    }

    /* ========================================
       RECONNECT
    ======================================== */

    scheduleReconnect() {
        if (
            this.stopping ||
            shuttingDown ||
            this.reconnectTimer
        ) {
            return;
        }

        const delay = this.reconnectDelay;

        this.log(
            `Reconnecting in ${delay}ms...`
        );

        this.setStatus("reconnecting");

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (!this.stopping && !shuttingDown) {
                this.connectGateway();
            }

        }, delay);

        this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            30000
        );
    }

    scheduleStartRetry() {
        if (
            this.stopping ||
            shuttingDown ||
            this.reconnectTimer
        ) {
            return;
        }

        const delay = this.reconnectDelay;

        this.log(
            `Retrying startup in ${delay}ms...`
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (!this.stopping && !shuttingDown) {
                this.start();
            }
        }, delay);

        this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            30000
        );
    }

    /* ========================================
       RESTART
    ======================================== */

    restart() {
        if (this.stopping || shuttingDown) return;

        this.log("Restarting WebSocket...");

        this.clearReconnectTimer();
        this.stopHeartbeat();

        this.reconnectDelay = 1000;

        if (!this.ws) {
            this.connecting = false;
            this.start();
            return;
        }

        this.restartPending = true;
        this.suppressReconnect = true;

        const socket = this.ws;

        try {
            socket.close(1000, "Manual restart");
        } catch {
            this.ws = null;
            this.connecting = false;
            this.suppressReconnect = false;
            this.restartPending = false;

            this.start();
        }
    }

    /* ========================================
       STOP
    ======================================== */

    stop() {
        if (this.stopping) return;

        this.stopping = true;
        this.restartPending = false;

        this.clearReconnectTimer();
        this.clearVoiceRejoinTimer();
        this.stopHeartbeat();

        this.log("Stopping WebSocket...");

        const socket = this.ws;

        this.ws = null;
        this.connecting = false;

        this.suppressReconnect = true;

        if (socket) {
            try {
                socket.close(1000, "Manager stop");
            } catch {}
        }

        this.setStatus("stopped");
    }
}

/* ============================================
   BOT CONFIG MANAGEMENT
============================================ */

function getBotConfig(botId) {
    return botConfigs.get(normalizeBotId(botId));
}

function createBot(botId) {
    botId = normalizeBotId(botId);

    const botConfig = getBotConfig(botId);

    if (!botConfig) {
        log(`Bot ${botId}: configuration not found.`);
        return null;
    }

    const instance = new BotConnection(botConfig);

    bots.set(botId, instance);

    return instance;
}

/* ============================================
   START BOTS
============================================ */

function startBots(ids) {
    for (const rawId of ids) {
        const id = normalizeBotId(rawId);

        if (!validId(id)) {
            log(`Invalid bot ID: ${rawId}`);
            continue;
        }

        if (bots.has(id)) {
            const existing = bots.get(id);

            if (
                existing.status !== "stopped" &&
                existing.status !== "login_failed"
            ) {
                log(`Bot ${id} is already running.`);
                continue;
            }

            bots.delete(id);
        }

        const instance = createBot(id);

        if (instance) {
            instance.start();
        }
    }
}

/* ============================================
   END BOTS
============================================ */

function endBots(ids) {
    for (const rawId of ids) {
        const id = normalizeBotId(rawId);

        const instance = bots.get(id);

        if (!instance) {
            log(`Bot ${id}: not running.`);
            continue;
        }

        instance.stop();

        bots.delete(id);

        log(`Bot ${id}: stopped.`);
    }
}

/* ============================================
   CHANGE CHANNEL
============================================ */

function changeBot(botId, channelId) {
    const id = normalizeBotId(botId);

    if (!validId(channelId)) {
        log("Invalid channel ID.");
        return;
    }

    const botConfig = getBotConfig(id);

    if (!botConfig) {
        log(`Bot ${id}: configuration not found.`);
        return;
    }

    botConfig.channelId = String(channelId);

    const instance = bots.get(id);

    if (!instance) {
        log(
            `Bot ${id} is stopped. Updated channel configuration only.`
        );
        return;
    }

    instance.changeChannel(channelId);
}

/* ============================================
   RESTART BOTS
============================================ */

function restartBots(ids) {
    for (const rawId of ids) {
        const id = normalizeBotId(rawId);

        const instance = bots.get(id);

        if (!instance) {
            log(`Bot ${id}: not running. Starting...`);

            startBots([id]);

            continue;
        }

        instance.restart();
    }
}

/* ============================================
   RELOAD ENV
============================================ */

function reloadEnv() {
    try {
        const oldConfigs = botConfigs;
        const oldConfig = config;

        loadEnv();

        log("Environment configuration reloaded.");

        if (oldConfig.guildId !== config.guildId) {
            log("GUILD_ID changed. Active connections will restart.");
        }

        for (const [id, instance] of bots) {
            const next = botConfigs.get(id);
            const previous = oldConfigs.get(id);

            // Bot removed from .env
            if (!next) {
                log(`Bot ${id}: removed from .env. Stopping.`);

                instance.stop();
                bots.delete(id);

                continue;
            }

            const tokenChanged =
                !previous ||
                previous.token !== next.token;

            const channelChanged =
                !previous ||
                previous.channelId !== next.channelId;

            const guildChanged =
                oldConfig.guildId !== config.guildId;

            instance.token = next.token;

            if (channelChanged) {
                instance.channelId = next.channelId;

                log(
                    `Bot ${id}: channel updated to ${next.channelId}`
                );
            }

            if (tokenChanged || guildChanged) {
                log(
                    `Bot ${id}: credentials/config changed. Restarting.`
                );

                instance.restart();

            } else if (channelChanged) {
                instance.changeChannel(next.channelId);
            }
        }

        log(
            `Configured bots: ${[...botConfigs.keys()].join(", ") || "none"}`
        );

        log("reloadenv completed.");

    } catch (error) {
        log(`reloadenv failed: ${error.message}`);
    }
}

/* ============================================
   STATUS
============================================ */

function showStatus() {
    console.log("");

    console.log(
        "=============== WEBSOCKET STATUS ==============="
    );

    if (botConfigs.size === 0) {
        console.log("No bots configured.");
    }

    for (const [id, config] of botConfigs) {
        const instance = bots.get(id);

        const status = instance
            ? instance.status
            : "stopped";

        const channelId = instance
            ? instance.channelId
            : config.channelId;

        console.log(
            `Bot ${id} | WebSocket: ${status.toUpperCase()} | Channel: ${channelId}`
        );
    }

    console.log(
        "================================================="
    );

    console.log("");
}

/* ============================================
   HELP
============================================ */

function showHelp() {
    console.log(`
Commands:

  start <bot id...>
      Start selected bots.

  end <bot id...>
      Stop selected bots.

  change <bot id> <channel id>
      Change a bot's voice channel.

  restart <bot id...>
      Restart selected WebSockets.

  reloadenv
      Reload .env configuration.

  status
      Show WebSocket status and channel IDs.

  help
      Show commands.

  exit
      Stop all bots and exit.

Examples:

  start 01
  start 01 02 03 04 10 11

  end 01
  end 01 02 03 04 10 11

  change 01 123456789012345678

  restart 01
  restart 01 02 03

  reloadenv

  status
`);
}

/* ============================================
   SHUTDOWN
============================================ */

function shutdown() {
    if (shuttingDown) return;

    shuttingDown = true;

    log("Shutting down manager...");

    for (const [id, instance] of bots) {
        instance.stop();
        log(`Bot ${id}: shutdown requested.`);
    }

    bots.clear();

    setTimeout(() => {
        process.exit(0);
    }, 500);
}

/* ============================================
   COMMAND HANDLER
============================================ */

function handleCommand(input) {
    const parts = input.trim().split(/\s+/);

    const command = parts.shift()?.toLowerCase();

    if (!command) return;

    switch (command) {

        case "start": {
            if (!parts.length) {
                log("Usage: start <bot id...>");
                return;
            }

            startBots(parts);
            break;
        }

        case "end": {
            if (!parts.length) {
                log("Usage: end <bot id...>");
                return;
            }

            endBots(parts);
            break;
        }

        case "change": {
            const [botId, channelId] = parts;

            if (!botId || !channelId) {
                log("Usage: change <bot id> <channel id>");
                return;
            }

            changeBot(botId, channelId);
            break;
        }

        case "restart": {
            if (!parts.length) {
                log("Usage: restart <bot id...>");
                return;
            }

            restartBots(parts);
            break;
        }

        case "reloadenv":
            reloadEnv();
            break;

        case "status":
            showStatus();
            break;

        case "help":
            showHelp();
            break;

        case "exit":
        case "quit":
            shutdown();
            break;

        default:
            log(`Unknown command: ${command}`);
            log('Type "help" for commands.');
    }
}

/* ============================================
   MAIN
============================================ */

function main() {
    console.log("");

    console.log(
        "=========================================="
    );

    console.log(
        "       DISCORD WEBSOCKET MANAGER"
    );

    console.log(
        "=========================================="
    );

    try {
        loadEnv();
    } catch (error) {
        log(`Configuration error: ${error.message}`);
        process.exit(1);
    }

    log(`Guild: ${config.guildId}`);

    log(`Configured bots: ${botConfigs.size}`);

    log("No bots started automatically.");

    console.log("");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "> "
    });

    rl.prompt();

    rl.on("line", line => {
        handleCommand(line);

        if (!shuttingDown) {
            rl.prompt();
        }
    });
}

/* ============================================
   SIGNALS
============================================ */

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();