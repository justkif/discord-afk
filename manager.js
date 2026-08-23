require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const readline = require("readline");

const BOTS_FILE = "./bots.json";
const WORKER_FILE = path.join(
    __dirname,
    "bot-worker.js"
);

const workers = new Map();

/* --------------------------------
   LOG
-------------------------------- */

function log(message) {
    console.log(
        `[${new Date().toLocaleTimeString()}] ${message}`
    );
}

/* --------------------------------
   BOT FILE
-------------------------------- */

function loadBots() {
    if (!fs.existsSync(BOTS_FILE)) {
        fs.writeFileSync(
            BOTS_FILE,
            "[]"
        );
    }

    try {
        const data =
            fs.readFileSync(
                BOTS_FILE,
                "utf8"
            );

        const bots = JSON.parse(data);

        if (!Array.isArray(bots)) {
            throw new Error(
                "bots.json must contain an array."
            );
        }

        return bots;

    } catch (error) {
        log(
            `ERROR reading bots.json: ${error.message}`
        );

        return [];
    }
}

function saveBots(bots) {
    fs.writeFileSync(
        BOTS_FILE,
        JSON.stringify(
            bots,
            null,
            2
        )
    );
}

/* --------------------------------
   TOKEN
-------------------------------- */

function getToken(botId) {
    const id =
        String(botId).padStart(2, "0");

    return process.env[
        `BOT_${id}_TOKEN`
    ];
}

/* --------------------------------
   FIND BOT CONFIG
-------------------------------- */

function findBot(botId) {
    const bots = loadBots();

    return bots.find(
        bot =>
            String(bot.id) ===
            String(botId)
    );
}

/* --------------------------------
   START WORKER
-------------------------------- */

function startWorker(
    botId,
    channelId
) {
    botId =
        String(botId).padStart(2, "0");

    channelId =
        String(channelId);

    if (workers.has(botId)) {
        log(
            `Bot ${botId} is already running.`
        );

        return false;
    }

    const token =
        getToken(botId);

    if (!token) {
        log(
            `Bot ${botId}: BOT_${botId}_TOKEN not found in .env`
        );

        return false;
    }

    log(
        `Starting worker for Bot ${botId}...`
    );

    const worker =
        fork(
            WORKER_FILE,
            [],
            {
                env: {
                    ...process.env,

                    BOT_ID: botId,
                    BOT_TOKEN: token,
                    CHANNEL_ID: channelId
                },

                stdio: [
                    "inherit",
                    "inherit",
                    "inherit",
                    "ipc"
                ]
            }
        );

    workers.set(
        botId,
        {
            worker,
            channelId,
            stopping: false
        }
    );

    worker.on(
        "message",
        message => {
            if (
                message?.type ===
                "status"
            ) {
                log(
                    `Bot ${botId}: ` +
                    `${message.status.toUpperCase()}`
                );
            }
        }
    );

    worker.on(
        "exit",
        (code, signal) => {
            const info =
                workers.get(botId);

            /*
             * Worker was intentionally
             * removed/restarted.
             */

            if (
                !info ||
                info.stopping
            ) {
                workers.delete(botId);
                return;
            }

            log(
                `Bot ${botId}: worker exited ` +
                `(code=${code}, signal=${signal})`
            );

            workers.delete(botId);

            /*
             * Unexpected crash:
             * automatically start it again.
             */

            log(
                `Bot ${botId}: restarting worker...`
            );

            setTimeout(() => {
                const config =
                    findBot(botId);

                if (config) {
                    startWorker(
                        botId,
                        config.channelId
                    );
                }
            }, 1000);
        }
    );

    worker.on(
        "error",
        error => {
            log(
                `Bot ${botId}: worker error: ${error.message}`
            );
        }
    );

    return true;
}

/* --------------------------------
   STOP WORKER
-------------------------------- */

function stopWorker(botId) {
    botId =
        String(botId).padStart(2, "0");

    const info =
        workers.get(botId);

    if (!info) {
        log(
            `Bot ${botId}: not running.`
        );

        return false;
    }

    info.stopping = true;

    try {
        info.worker.send({
            type: "stop"
        });
    } catch {
        try {
            info.worker.kill();
        } catch {}
    }

    workers.delete(botId);

    return true;
}

/* --------------------------------
   ADD
-------------------------------- */

function addBot(
    botId,
    channelId
) {
    botId =
        String(botId).padStart(2, "0");

    channelId =
        String(channelId);

    if (!/^\d+$/.test(botId)) {
        log(
            "Invalid bot number."
        );

        return;
    }

    if (!/^\d+$/.test(channelId)) {
        log(
            "Invalid room ID."
        );

        return;
    }

    if (findBot(botId)) {
        log(
            `Bot ${botId} already exists in bots.json.`
        );

        return;
    }

    if (!getToken(botId)) {
        log(
            `BOT_${botId}_TOKEN is missing from .env`
        );

        return;
    }

    const bots =
        loadBots();

    bots.push({
        id: botId,
        channelId
    });

    saveBots(bots);

    log(
        `Bot ${botId} saved → Room ${channelId}`
    );

    /*
     * Start ONLY this bot.
     * Existing workers are untouched.
     */

    startWorker(
        botId,
        channelId
    );
}

/* --------------------------------
   REMOVE
-------------------------------- */

function removeBot(
    botId,
    channelId
) {
    botId =
        String(botId).padStart(2, "0");

    channelId =
        String(channelId);

    const bots =
        loadBots();

    const bot =
        bots.find(
            item =>
                String(item.id) ===
                botId
        );

    if (!bot) {
        log(
            `Bot ${botId} not found.`
        );

        return;
    }

    /*
     * If a room ID was supplied,
     * verify it matches.
     */

    if (
        channelId &&
        String(bot.channelId) !==
        channelId
    ) {
        log(
            `Bot ${botId} is not assigned to room ${channelId}.`
        );

        return;
    }

    /*
     * Disconnect ONLY this bot.
     */

    stopWorker(botId);

    /*
     * Remove its configuration.
     */

    const newBots =
        bots.filter(
            item =>
                String(item.id) !==
                botId
        );

    saveBots(newBots);

    log(
        `Bot ${botId} removed.`
    );
}

/* --------------------------------
   CHANGE ROOM
-------------------------------- */

function changeBot(
    botId,
    newChannelId
) {
    botId =
        String(botId).padStart(2, "0");

    newChannelId =
        String(newChannelId);

    if (!/^\d+$/.test(newChannelId)) {
        log(
            "Invalid room ID."
        );

        return;
    }

    const bots =
        loadBots();

    const bot =
        bots.find(
            item =>
                String(item.id) ===
                botId
        );

    if (!bot) {
        log(
            `Bot ${botId} not found.`
        );

        return;
    }

    /*
     * Update bots.json FIRST.
     */

    bot.channelId =
        newChannelId;

    saveBots(bots);

    /*
     * Tell the existing worker to
     * move to the new room.
     */

    const info =
        workers.get(botId);

    if (!info) {
        /*
         * Bot isn't currently running.
         * Start it in the new room.
         */

        startWorker(
            botId,
            newChannelId
        );

        return;
    }

    info.channelId =
        newChannelId;

    info.worker.send({
        type: "change",
        channelId: newChannelId
    });

    log(
        `Bot ${botId}: changing room → ${newChannelId}`
    );
}

/* --------------------------------
   RESTART
-------------------------------- */

function restartBot(botId) {
    botId =
        String(botId).padStart(2, "0");

    const bot =
        findBot(botId);

    if (!bot) {
        log(
            `Bot ${botId} not found in bots.json.`
        );

        return;
    }

    /*
     * Stop only this worker.
     */

    const info =
        workers.get(botId);

    if (info) {
        info.stopping = true;

        try {
            info.worker.send({
                type: "stop"
            });
        } catch {
            try {
                info.worker.kill();
            } catch {}
        }

        workers.delete(botId);
    }

    /*
     * Start the same bot again.
     */

    setTimeout(() => {
        startWorker(
            botId,
            bot.channelId
        );
    }, 500);

    log(
        `Bot ${botId}: restarting...`
    );
}

/* --------------------------------
   STATUS
-------------------------------- */

function status() {
    const bots =
        loadBots();

    console.log("");
    console.log(
        "============== BOT STATUS =============="
    );

    if (bots.length === 0) {
        console.log(
            "No bots configured."
        );
    }

    for (const bot of bots) {
        const id =
            String(bot.id)
                .padStart(2, "0");

        const running =
            workers.has(id);

        console.log(
            `Bot ${id} | ` +
            `Process: ${
                running
                    ? "RUNNING"
                    : "STOPPED"
            } | ` +
            `Room: ${bot.channelId}`
        );
    }

    console.log(
        "========================================="
    );

    console.log("");
}

/* --------------------------------
   COMMANDS
-------------------------------- */

async function handleCommand(input) {
    const parts =
        input
            .trim()
            .split(/\s+/);

    const command =
        parts
            .shift()
            ?.toLowerCase();

    if (!command) {
        return;
    }

    switch (command) {

        case "add": {
            /*
             * add <bot no> <room id>
             */

            const [
                botId,
                channelId
            ] = parts;

            if (
                !botId ||
                !channelId
            ) {
                console.log(
                    "Usage: add <bot no.> <room id>"
                );

                return;
            }

            addBot(
                botId,
                channelId
            );

            break;
        }

        case "remove": {
            /*
             * remove <bot no> <room id>
             */

            const [
                botId,
                channelId
            ] = parts;

            if (
                !botId ||
                !channelId
            ) {
                console.log(
                    "Usage: remove <bot no.> <room id>"
                );

                return;
            }

            removeBot(
                botId,
                channelId
            );

            break;
        }

        case "change": {
            /*
             * change <bot no> <new room id>
             */

            const [
                botId,
                channelId
            ] = parts;

            if (
                !botId ||
                !channelId
            ) {
                console.log(
                    "Usage: change <bot no.> <room id>"
                );

                return;
            }

            changeBot(
                botId,
                channelId
            );

            break;
        }

        case "restart": {
            /*
             * restart <bot no>
             */

            const [botId] =
                parts;

            if (!botId) {
                console.log(
                    "Usage: restart <bot no.>"
                );

                return;
            }

            restartBot(botId);

            break;
        }

        case "status": {
            status();
            break;
        }

        case "help": {
            console.log(`
Commands:

add <bot no.> <room id>
    Add bot to bots.json and start it.

remove <bot no.> <room id>
    Remove bot from bots.json and disconnect it.

change <bot no.> <room id>
    Change the bot's room and move it.

restart <bot no.>
    Restart only that bot.

status
    Show bot/process status.

help
    Show commands.

exit
    Stop all bot workers and exit.
`);

            break;
        }

        case "exit": {
            shutdown();
            break;
        }

        default:
            console.log(
                `Unknown command: ${command}`
            );
    }
}

/* --------------------------------
   START SAVED BOTS
-------------------------------- */

function startSavedBots() {
    const bots =
        loadBots();

    log(
        `Loading ${bots.length} saved bot(s)...`
    );

    for (
        const bot of bots
    ) {
        startWorker(
            bot.id,
            bot.channelId
        );
    }
}

/* --------------------------------
   SHUTDOWN
-------------------------------- */

function shutdown() {
    log(
        "Stopping all bot workers..."
    );

    for (
        const [
            id,
            info
        ] of workers
    ) {
        info.stopping = true;

        try {
            info.worker.send({
                type: "stop"
            });
        } catch {
            try {
                info.worker.kill();
            } catch {}
        }
    }

    workers.clear();

    process.exit(0);
}

/* --------------------------------
   MAIN
-------------------------------- */

function main() {
    console.log("");
    console.log(
        "=================================="
    );
    console.log(
        "       DISCORD AFK BOT MANAGER"
    );
    console.log(
        "=================================="
    );
    console.log("");

    startSavedBots();

    console.log("");
    console.log(
        'Type "help" for commands.'
    );
    console.log("");

    const rl =
        readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: "> "
        });

    rl.prompt();

    rl.on(
        "line",
        async line => {
            await handleCommand(line);
            rl.prompt();
        }
    );
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);

main();