const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const readline = require("readline");

const BOTS_FILE = path.join(
    __dirname,
    "bots.json"
);

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
            "[]",
            "utf8"
        );
    }

    try {
        const data = fs.readFileSync(
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
        ),
        "utf8"
    );
}

/* --------------------------------
   FIND BOT CONFIG
-------------------------------- */

function findBot(botId) {
    const id =
        String(botId).padStart(2, "0");

    const bots = loadBots();

    return bots.find(
        bot =>
            String(bot.id).padStart(2, "0") === id
    );
}

/* --------------------------------
   START WORKER
-------------------------------- */

function startWorker(
    botId,
    channelId,
    token
) {
    botId =
        String(botId).padStart(2, "0");

    channelId =
        String(channelId);

    token =
        String(token || "");

    if (workers.has(botId)) {
        log(
            `Bot ${botId} is already running.`
        );

        return false;
    }

    if (!token) {
        log(
            `Bot ${botId}: token is missing in bots.json.`
        );

        return false;
    }

    if (!/^\d+$/.test(channelId)) {
        log(
            `Bot ${botId}: invalid room ID.`
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

    /* --------------------------------
       WORKER → MANAGER
    -------------------------------- */

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

    /* --------------------------------
       WORKER EXIT
    -------------------------------- */

    worker.on(
        "exit",
        (code, signal) => {
            const info =
                workers.get(botId);

            /*
             * Worker was intentionally
             * stopped/restarted.
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

                if (
                    config &&
                    config.token &&
                    config.channelId
                ) {
                    startWorker(
                        config.id,
                        config.channelId,
                        config.token
                    );
                }
            }, 1000);
        }
    );

    /* --------------------------------
       WORKER ERROR
    -------------------------------- */

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
    channelId,
    token
) {
    botId =
        String(botId).padStart(2, "0");

    channelId =
        String(channelId);

    token =
        String(token || "");

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

    if (!token) {
        log(
            "Bot token is required."
        );

        return;
    }

    if (findBot(botId)) {
        log(
            `Bot ${botId} already exists in bots.json.`
        );

        return;
    }

    const bots =
        loadBots();

    bots.push({
        id: botId,
        token: token,
        channelId: channelId
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
        channelId,
        token
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
                String(item.id).padStart(2, "0") ===
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
                String(item.id).padStart(2, "0") !==
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
                String(item.id).padStart(2, "0") ===
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
            newChannelId,
            bot.token
        );

        return;
    }

    info.channelId =
        newChannelId;

    try {
        info.worker.send({
            type: "change",
            channelId: newChannelId
        });
    } catch (error) {
        log(
            `Bot ${botId}: failed to send room change: ${error.message}`
        );

        return;
    }

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

    if (!bot.token) {
        log(
            `Bot ${botId}: token missing in bots.json.`
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
            bot.id,
            bot.channelId,
            bot.token
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
            `Room: ${bot.channelId} | ` +
            `Token: ${
                bot.token
                    ? "SET"
                    : "MISSING"
            }`
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

        /* --------------------------------
           ADD
        -------------------------------- */

        case "add": {
            /*
             * add <bot no> <room id> <token>
             */

            const [
                botId,
                channelId,
                token
            ] = parts;

            if (
                !botId ||
                !channelId ||
                !token
            ) {
                console.log(
                    "Usage: add <bot no.> <room id> <token>"
                );

                return;
            }

            addBot(
                botId,
                channelId,
                token
            );

            break;
        }

        /* --------------------------------
           REMOVE
        -------------------------------- */

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

        /* --------------------------------
           CHANGE
        -------------------------------- */

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

        /* --------------------------------
           RESTART
        -------------------------------- */

        case "restart": {
            /*
             * restart <bot no>
             */

            const [
                botId
            ] = parts;

            if (!botId) {
                console.log(
                    "Usage: restart <bot no.>"
                );

                return;
            }

            restartBot(botId);

            break;
        }

        /* --------------------------------
           STATUS
        -------------------------------- */

        case "status": {
            status();
            break;
        }

        /* --------------------------------
           HELP
        -------------------------------- */

        case "help": {
            console.log(`
Commands:

add <bot no.> <room id> <token>
    Add a bot to bots.json and start it.

remove <bot no.> <room id>
    Remove the bot from bots.json and disconnect it.

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

        /* --------------------------------
           EXIT
        -------------------------------- */

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

    for (const bot of bots) {
        const botId =
            String(bot.id)
                .padStart(2, "0");

        if (!bot.token) {
            log(
                `Bot ${botId}: token missing in bots.json. Skipping.`
            );

            continue;
        }

        if (!bot.channelId) {
            log(
                `Bot ${botId}: channel ID missing in bots.json. Skipping.`
            );

            continue;
        }

        startWorker(
            botId,
            bot.channelId,
            bot.token
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