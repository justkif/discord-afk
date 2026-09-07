const {
    Client,
    GatewayIntentBits,
    ChannelType
} = require("discord.js");

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const botId =
    String(process.env.BOT_ID)
        .padStart(2, "0");

const token =
    process.env.BOT_TOKEN;

let channelId =
    process.env.CHANNEL_ID;

let client = null;
let connection = null;

let stopping = false;
let reconnecting = false;

/* --------------------------------
   LOG
-------------------------------- */

function log(message) {
    console.log(
        `[${new Date().toLocaleTimeString()}] ` +
        `[BOT ${botId}] ${message}`
    );
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

    client.once(
        "ready",
        async () => {
            log(
                `ONLINE as ${client.user.tag}`
            );

            await connectToRoom();
        }
    );

    client.on(
        "error",
        error => {
            log(
                `Discord error: ${error.message}`
            );
        }
    );

    client.on(
        "shardError",
        error => {
            log(
                `Shard error: ${error.message}`
            );
        }
    );

    client.on(
        "disconnect",
        () => {
            log(
                "Discord gateway disconnected"
            );
        }
    );
}

/* --------------------------------
   CONNECT TO ROOM
-------------------------------- */

async function connectToRoom() {
    if (
        stopping ||
        !client?.isReady()
    ) {
        return;
    }

    try {
        const channel =
            await client.channels.fetch(
                channelId
            );

        if (!channel) {
            log(
                `Room ${channelId} not found.`
            );

            scheduleReconnect();

            return;
        }

        if (
            channel.type !==
            ChannelType.GuildVoice
        ) {
            log(
                `Room ${channelId} is not a voice channel.`
            );

            scheduleReconnect();

            return;
        }

        /*
         * This worker belongs to ONE bot.
         *
         * It only manages its own
         * voice connection.
         */

        if (connection) {
            try {
                connection.destroy();
            } catch {}

            connection = null;
        }

        connection =
            joinVoiceChannel({
                channelId:
                    channel.id,

                guildId:
                    channel.guild.id,

                adapterCreator:
                    channel.guild
                        .voiceAdapterCreator,

                /*
                 * AFK bot:
                 * no audio
                 * no microphone
                 */

                selfMute: true,
                selfDeaf: true
            });

        const thisConnection =
            connection;

        /* --------------------------------
           VOICE READY
        -------------------------------- */

        connection.on(
            VoiceConnectionStatus.Ready,
            () => {
                if (
                    connection !==
                    thisConnection
                ) {
                    return;
                }

                log(
                    `CONNECTED → ${channel.name}`
                );

                sendStatus(
                    "connected"
                );
            }
        );

        /* --------------------------------
           VOICE DISCONNECTED
        -------------------------------- */

        connection.on(
            VoiceConnectionStatus.Disconnected,
            async () => {
                if (
                    connection !==
                    thisConnection
                ) {
                    return;
                }

                log(
                    "VOICE DISCONNECTED → reconnecting"
                );

                sendStatus(
                    "disconnected"
                );

                await reconnect();
            }
        );

        /* --------------------------------
           VOICE DESTROYED
        -------------------------------- */

        connection.on(
            VoiceConnectionStatus.Destroyed,
            () => {
                if (
                    connection ===
                    thisConnection
                ) {
                    log(
                        "VOICE CONNECTION DESTROYED"
                    );
                }
            }
        );

    } catch (error) {
        log(
            `Voice connection error: ${error.message}`
        );

        sendStatus(
            "error"
        );

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

/* --------------------------------
   SCHEDULE RECONNECT
-------------------------------- */

function scheduleReconnect() {
    if (
        stopping ||
        reconnecting
    ) {
        return;
    }

    setTimeout(
        () => {
            reconnect();
        },
        100
    );
}

/* --------------------------------
   CHANGE ROOM
-------------------------------- */

async function changeRoom(
    newChannelId
) {
    if (
        !/^\d+$/.test(
            String(newChannelId)
        )
    ) {
        log(
            "Invalid room ID."
        );

        return;
    }

    channelId =
        String(newChannelId);

    log(
        `Changing room → ${channelId}`
    );

    await reconnect();
}

/* --------------------------------
   IPC STATUS
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

/* --------------------------------
   IPC COMMANDS
-------------------------------- */

process.on(
    "message",
    async message => {
        if (
            !message ||
            !message.type
        ) {
            return;
        }

        /* --------------------------------
           CHANGE
        -------------------------------- */

        if (
            message.type ===
            "change"
        ) {
            await changeRoom(
                message.channelId
            );
        }

        /* --------------------------------
           RESTART
        -------------------------------- */

        if (
            message.type ===
            "restart"
        ) {
            log(
                "Restart requested."
            );

            await reconnect();
        }

        /* --------------------------------
           STOP
        -------------------------------- */

        if (
            message.type ===
            "stop"
        ) {
            stopping = true;

            log(
                "Stopping bot..."
            );

            try {
                if (connection) {
                    connection.destroy();
                    connection = null;
                }
            } catch (error) {
                log(
                    `Voice disconnect error: ${error.message}`
                );
            }

            try {
                if (client) {
                    client.destroy();
                    client = null;
                }
            } catch (error) {
                log(
                    `Discord disconnect error: ${error.message}`
                );
            }

            /*
             * Give Discord/voice adapter
             * a moment to process shutdown.
             */

            setTimeout(
                () => {
                    process.exit(0);
                },
                250
            );

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
            "TOKEN NOT FOUND IN BOTS.JSON."
        );

        process.exit(1);
    }

    if (!channelId) {
        log(
            "CHANNEL ID NOT PROVIDED."
        );

        process.exit(1);
    }

    createClient();

    try {
        await client.login(
            token
        );

    } catch (error) {
        log(
            `LOGIN FAILED: ${error.message}`
        );

        /*
         * Keep the worker alive so
         * the manager can continue
         * managing this process.
         */

        scheduleReconnect();
    }
}

/* --------------------------------
   SIGINT
-------------------------------- */

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

/* --------------------------------
   SIGTERM
-------------------------------- */

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

/* --------------------------------
   START
-------------------------------- */

start();