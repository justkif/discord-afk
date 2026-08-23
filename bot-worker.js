require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    ChannelType
} = require("discord.js");

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const botId = String(process.env.BOT_ID).padStart(2, "0");
const token = process.env.BOT_TOKEN;

let channelId = process.env.CHANNEL_ID;

let client = null;
let connection = null;

let stopping = false;
let reconnecting = false;

function log(message) {
    console.log(
        `[${new Date().toLocaleTimeString()}] ` +
        `[BOT ${botId}] ${message}`
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* --------------------------------
   CREATE DISCORD CLIENT
-------------------------------- */

function createClient() {
    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates
        ]
    });

    client.once("ready", async () => {
        log(`ONLINE as ${client.user.tag}`);

        await connectToRoom();
    });

    client.on("error", error => {
        log(`Discord error: ${error.message}`);
    });

    client.on("shardError", error => {
        log(`Shard error: ${error.message}`);
    });

    client.on("disconnect", () => {
        log("Discord gateway disconnected");
    });
}

/* --------------------------------
   CONNECT TO ROOM
-------------------------------- */

async function connectToRoom() {
    if (stopping || !client?.isReady()) {
        return;
    }

    try {
        const channel =
            await client.channels.fetch(channelId);

        if (!channel) {
            log(`Room ${channelId} not found.`);
            scheduleReconnect();
            return;
        }

        if (channel.type !== ChannelType.GuildVoice) {
            log(
                `Room ${channelId} is not a voice channel.`
            );

            scheduleReconnect();
            return;
        }

        /*
         * This worker belongs to ONE bot.
         *
         * There is no getVoiceConnection()
         * and no attempt to touch another bot.
         */

        if (connection) {
            try {
                connection.destroy();
            } catch {}

            connection = null;
        }

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,

            /*
             * The bot does absolutely nothing.
             * No audio is played.
             * No microphone is transmitted.
             */

            selfMute: true,
            selfDeaf: true
        });

        const thisConnection = connection;

        connection.on(
            VoiceConnectionStatus.Ready,
            () => {
                if (connection !== thisConnection) {
                    return;
                }

                log(
                    `CONNECTED → ${channel.name}`
                );

                sendStatus("connected");
            }
        );

        connection.on(
            VoiceConnectionStatus.Disconnected,
            async () => {
                if (connection !== thisConnection) {
                    return;
                }

                log(
                    "VOICE DISCONNECTED → reconnecting"
                );

                sendStatus("disconnected");

                /*
                 * Don't wait 5 or 10 seconds.
                 * Try again almost immediately.
                 */

                await reconnect();
            }
        );

        connection.on(
            VoiceConnectionStatus.Destroyed,
            () => {
                if (connection === thisConnection) {
                    log("VOICE CONNECTION DESTROYED");
                }
            }
        );

    } catch (error) {
        log(
            `Voice connection error: ${error.message}`
        );

        sendStatus("error");

        scheduleReconnect();
    }
}

/* --------------------------------
   RECONNECT
-------------------------------- */

async function reconnect() {
    if (
        stopping ||
        reconnecting
    ) {
        return;
    }

    reconnecting = true;

    try {
        if (connection) {
            try {
                connection.destroy();
            } catch {}

            connection = null;
        }

        if (!stopping) {
            await connectToRoom();
        }

    } finally {
        reconnecting = false;
    }
}

function scheduleReconnect() {
    if (
        stopping ||
        reconnecting
    ) {
        return;
    }

    setTimeout(() => {
        reconnect();
    }, 100);
}

/* --------------------------------
   CHANGE ROOM
-------------------------------- */

async function changeRoom(newChannelId) {
    if (!/^\d+$/.test(String(newChannelId))) {
        log("Invalid room ID.");
        return;
    }

    channelId = String(newChannelId);

    log(
        `Changing room → ${channelId}`
    );

    await reconnect();
}

/* --------------------------------
   IPC
-------------------------------- */

function sendStatus(status) {
    if (process.send) {
        process.send({
            type: "status",
            botId,
            status,
            channelId
        });
    }
}

process.on(
    "message",
    async message => {
        if (!message || !message.type) {
            return;
        }

        if (message.type === "change") {
            await changeRoom(
                message.channelId
            );
        }

        if (message.type === "restart") {
            log("Restart requested.");

            await reconnect();
        }

        if (message.type === "stop") {
            stopping = true;

            log("Stopping bot...");

            try {
                if (connection) {
                    connection.destroy();
                    connection = null;
                }
            } catch (error) {
                log(`Voice disconnect error: ${error.message}`);
            }

            try {
                if (client) {
                    client.destroy();
                    client = null;
                }
            } catch (error) {
                log(`Discord disconnect error: ${error.message}`);
            }

            // Give Discord/voice adapter a moment to process the disconnect
            setTimeout(() => {
                process.exit(0);
            }, 250);

            return;
        }
    }
);

/* --------------------------------
   START
-------------------------------- */

async function start() {
    if (!token) {
        log(
            `TOKEN NOT FOUND: BOT_${botId}_TOKEN`
        );

        process.exit(1);
    }

    if (!channelId) {
        log("CHANNEL ID NOT PROVIDED.");

        process.exit(1);
    }

    createClient();

    try {
        await client.login(token);
    } catch (error) {
        log(
            `LOGIN FAILED: ${error.message}`
        );

        /*
         * The worker stays alive and keeps
         * attempting to reconnect.
         */

        scheduleReconnect();
    }
}

process.on(
    "SIGINT",
    () => {
        stopping = true;

        if (connection) {
            try {
                connection.destroy();
            } catch {}
        }

        if (client) {
            client.destroy();
        }

        process.exit(0);
    }
);

process.on(
    "SIGTERM",
    () => {
        stopping = true;

        if (connection) {
            try {
                connection.destroy();
            } catch {}
        }

        if (client) {
            client.destroy();
        }

        process.exit(0);
    }
);

start();