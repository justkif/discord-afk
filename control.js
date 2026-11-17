"use strict";

const net = require("net");
const readline = require("readline");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CONTROL_PORT || 47831);

const socket = net.createConnection({ host: HOST, port: PORT });
socket.setEncoding("utf8");

socket.on("connect", () => {
    const args = process.argv.slice(2);

    if (args.length) {
        socket.write(args.join(" ") + "\n");
        // Keep the connection briefly so the manager can return command output.
        setTimeout(() => socket.end(), 500);
        return;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "> "
    });

    rl.prompt();
    rl.on("line", line => {
        if (line.trim().toLowerCase() === "exit" || line.trim().toLowerCase() === "quit") {
            socket.write(line.trim() + "\n");
            rl.close();
            socket.end();
            return;
        }

        socket.write(line + "\n");
        rl.prompt();
    });

    rl.on("close", () => socket.end());
});

socket.on("data", data => process.stdout.write(data));

socket.on("error", error => {
    console.error(`Cannot connect to manager: ${error.message}`);
    console.error("Make sure index.js is running in this Railway deployment.");
    process.exitCode = 1;
});

socket.on("close", () => process.exit(process.exitCode || 0));
