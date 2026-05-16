/**
 * mqtt-tools — MQTT connection, publish, subscribe, topic discovery.
 */
'use strict';

let mqttClient = null;
let subscribedTopics = new Map();
let messageBuffer = [];
const MAX_BUFFER = 200;

function descriptors() {
    return [
        {
            name: 'connect',
            description: 'Connect to an MQTT broker. Returns connection status.',
            input_schema: {
                type: 'object',
                required: ['brokerUrl'],
                properties: {
                    brokerUrl: { type: 'string', description: 'MQTT broker URL, e.g. mqtt://localhost:1883' },
                    username: { type: 'string', description: 'Username (optional)' },
                    password: { type: 'string', description: 'Password (optional)' },
                    clientId: { type: 'string', description: 'Client ID (optional, auto-generated if omitted)' }
                }
            }
        },
        {
            name: 'publish',
            description: 'Publish a message to an MQTT topic.',
            input_schema: {
                type: 'object',
                required: ['topic', 'payload'],
                properties: {
                    topic: { type: 'string', description: 'MQTT topic to publish to' },
                    payload: { type: 'string', description: 'Message payload' },
                    qos: { type: 'number', description: 'QoS level: 0, 1, or 2 (default 0)' },
                    retain: { type: 'boolean', description: 'Retain message (default false)' }
                }
            }
        },
        {
            name: 'subscribe',
            description: 'Subscribe to an MQTT topic (supports wildcards + and #).',
            input_schema: {
                type: 'object',
                required: ['topic'],
                properties: {
                    topic: { type: 'string', description: 'MQTT topic filter, e.g. sensors/#' },
                    qos: { type: 'number', description: 'QoS level: 0, 1, or 2 (default 0)' }
                }
            }
        },
        {
            name: 'unsubscribe',
            description: 'Unsubscribe from an MQTT topic.',
            input_schema: {
                type: 'object',
                required: ['topic'],
                properties: {
                    topic: { type: 'string', description: 'Topic to unsubscribe from' }
                }
            }
        },
        {
            name: 'list_topics',
            description: 'List currently subscribed topics and their message counts.',
            input_schema: { type: 'object', properties: {} }
        },
        {
            name: 'read_messages',
            description: 'Read recent messages from the buffer. Optionally filter by topic.',
            input_schema: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'Filter by topic (optional, returns all if omitted)' },
                    limit: { type: 'number', description: 'Max messages to return (default 50)' },
                    since: { type: 'number', description: 'Return messages after this timestamp (ms)' }
                }
            }
        }
    ];
}

function executors(ctx) {
    const logger = ctx?.logger;

    return {
        async connect(args) {
            try {
                let mqtt;
                try { mqtt = require('mqtt'); } catch (_) {
                    return { error: 'mqtt_not_available', message: 'mqtt npm package is not installed' };
                }
                if (mqttClient) {
                    mqttClient.end(true);
                    mqttClient = null;
                }
                const opts = {};
                if (args.username) opts.username = args.username;
                if (args.password) opts.password = args.password;
                if (args.clientId) opts.clientId = args.clientId;
                mqttClient = mqtt.connect(args.brokerUrl, opts);

                return await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        resolve({ ok: false, error: 'connection_timeout', brokerUrl: args.brokerUrl });
                    }, 8000);
                    mqttClient.on('connect', () => {
                        clearTimeout(timer);
                        subscribedTopics.clear();
                        mqttClient.on('message', (topic, msg) => {
                            messageBuffer.push({
                                topic,
                                payload: msg.toString(),
                                timestamp: Date.now()
                            });
                            if (messageBuffer.length > MAX_BUFFER) {
                                messageBuffer = messageBuffer.slice(-MAX_BUFFER);
                            }
                            const cnt = subscribedTopics.get(topic) || 0;
                            subscribedTopics.set(topic, cnt + 1);
                        });
                        logger?.info?.(`mqtt-tools: connected to ${args.brokerUrl}`);
                        resolve({ ok: true, brokerUrl: args.brokerUrl });
                    });
                    mqttClient.on('error', (err) => {
                        clearTimeout(timer);
                        resolve({ ok: false, error: String(err.message || err), brokerUrl: args.brokerUrl });
                    });
                });
            } catch (err) {
                return { error: String(err.message || err) };
            }
        },

        async publish(args) {
            if (!mqttClient || !mqttClient.connected) {
                return { error: 'not_connected', message: 'Call connect first' };
            }
            return new Promise((resolve) => {
                const opts = {};
                if (args.qos != null) opts.qos = args.qos;
                if (args.retain != null) opts.retain = args.retain;
                mqttClient.publish(args.topic, args.payload, opts, (err) => {
                    if (err) resolve({ ok: false, error: String(err.message || err) });
                    else resolve({ ok: true, topic: args.topic });
                });
            });
        },

        async subscribe(args) {
            if (!mqttClient || !mqttClient.connected) {
                return { error: 'not_connected', message: 'Call connect first' };
            }
            return new Promise((resolve) => {
                const opts = {};
                if (args.qos != null) opts.qos = args.qos;
                mqttClient.subscribe(args.topic, opts, (err, granted) => {
                    if (err) resolve({ ok: false, error: String(err.message || err) });
                    else {
                        subscribedTopics.set(args.topic, 0);
                        resolve({ ok: true, topic: args.topic, granted });
                    }
                });
            });
        },

        async unsubscribe(args) {
            if (!mqttClient || !mqttClient.connected) {
                return { error: 'not_connected', message: 'Call connect first' };
            }
            return new Promise((resolve) => {
                mqttClient.unsubscribe(args.topic, (err) => {
                    if (err) resolve({ ok: false, error: String(err.message || err) });
                    else {
                        subscribedTopics.delete(args.topic);
                        resolve({ ok: true, topic: args.topic });
                    }
                });
            });
        },

        async list_topics() {
            const topics = [];
            for (const [topic, count] of subscribedTopics) {
                topics.push({ topic, messageCount: count });
            }
            return { connected: !!(mqttClient && mqttClient.connected), topics };
        },

        async read_messages(args) {
            let msgs = messageBuffer;
            if (args?.topic) {
                msgs = msgs.filter(m => m.topic === args.topic || _topicMatch(m.topic, args.topic));
            }
            if (args?.since) {
                msgs = msgs.filter(m => m.timestamp >= args.since);
            }
            const limit = args?.limit || 50;
            msgs = msgs.slice(-limit);
            return { messages: msgs, total: msgs.length };
        }
    };
}

function _topicMatch(actual, filter) {
    const a = actual.split('/');
    const f = filter.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (f[i] === '+') continue;
        if (a[i] !== f[i]) return false;
    }
    return a.length === f.length;
}

module.exports = { descriptors, executors };
