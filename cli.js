// cli.js
const readline = require("readline");
const http = require("http");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> "
});

console.log("Connected to Discord WebSocket Manager.");
rl.prompt();

rl.on("line", (line) => {
    const cmd = line.trim();
    if (!cmd) return rl.prompt();
    if (cmd === "exit") process.exit(0);

    const req = http.request({
        hostname: "127.0.0.1",
        port: 3001,
        method: "POST"
    }, () => {
        rl.prompt();
    });

    req.write(cmd);
    req.end();
});
