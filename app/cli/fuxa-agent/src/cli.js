/**
 * FUXA Agent CLI entry. Hand-rolled argv parser to keep zero deps.
 *
 *   fuxa-agent login --server https://... --apikey ...
 *   fuxa-agent doctor
 *   fuxa-agent connect "<natural-language description>" [--dry-run] [--yes]
 *   fuxa-agent connect --file plan.yaml
 *   fuxa-agent device ls|rm|show
 *   fuxa-agent tags ls --device <name>
 */
'use strict';

const path = require('path');

const COMMANDS = {
    login:   require('./commands/login'),
    doctor:  require('./commands/doctor'),
    connect: require('./commands/connect'),
    device:  require('./commands/device'),
    tags:    require('./commands/tags'),
    view:    require('./commands/view')
};

function parse(argv) {
    const [cmd, ...rest] = argv;
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--' ) { positional.push(...rest.slice(i + 1)); break; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const key = (eq === -1 ? a : a.slice(0, eq)).slice(2);
            let val;
            if (eq !== -1) {
                val = a.slice(eq + 1);
            } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
                val = rest[++i];
            } else {
                val = true;
            }
            flags[key] = val;
        } else {
            positional.push(a);
        }
    }
    return { cmd, positional, flags };
}

function help() {
    console.log(`fuxa-agent — natural-language device & tag provisioning for FUXA

Usage:
  fuxa-agent login   --server <url> --apikey <key>
  fuxa-agent doctor
  fuxa-agent connect "<natural-language description>"
                     [--dry-run] [--yes] [--file plan.yaml]
  fuxa-agent device  ls | show <name> | rm <name>
  fuxa-agent tags    ls --device <name>
  fuxa-agent view    ls | show <name> [--json] | resize <name> --width N --height N | ask <name> "description"

Configuration is stored at ~/.fuxa-agent/config.json.
Environment overrides:  FUXA_AGENT_SERVER, FUXA_AGENT_APIKEY.
`);
}

(async function main() {
    const { cmd, positional, flags } = parse(process.argv.slice(2));
    if (!cmd || cmd === 'help' || flags.help) {
        help();
        process.exit(cmd ? 0 : 1);
    }
    const handler = COMMANDS[cmd];
    if (!handler) {
        console.error(`Unknown command: ${cmd}`);
        help();
        process.exit(1);
    }
    try {
        await handler({ positional, flags });
    } catch (err) {
        console.error(`error: ${err?.message || err}`);
        if (process.env.FUXA_AGENT_DEBUG) console.error(err?.stack);
        process.exit(2);
    }
})();
