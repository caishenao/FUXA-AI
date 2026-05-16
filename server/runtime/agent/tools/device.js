/**
 * Device & Tag tools: device CRUD, tag browsing, live values.
 *
 * These tools let the agent manage FUXA devices and tags:
 * list devices, add/update/delete devices, browse tags,
 * read live tag values, set tag values, query historical data.
 */
'use strict';

function genId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

const DEVICE_TYPES = [
    'SiemensS7', 'OPCUA', 'ModbusRTU', 'ModbusTCP', 'BACnet',
    'WebAPI', 'MQTTclient', 'EthernetIP', 'FuxaServer', 'ODBC',
    'ADSclient', 'GPIO', 'WebCam', 'MELSEC', 'REDIS'
];

function descriptors() {
    return [
        {
            name: 'device_list',
            description: 'List all configured devices with their id, name, type, enabled status, and tag count.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional substring filter on device name.' }
                }
            }
        },
        {
            name: 'device_read',
            description: 'Read the full configuration of a specific device by name or id, including all tags.',
            input_schema: {
                type: 'object',
                required: ['device'],
                properties: {
                    device: { type: 'string', description: 'Device name or id.' }
                }
            }
        },
        {
            name: 'device_add',
            description: 'Add a new device to the project.',
            input_schema: {
                type: 'object',
                required: ['name', 'type'],
                properties: {
                    name: { type: 'string', maxLength: 64 },
                    type: { type: 'string', enum: DEVICE_TYPES },
                    enabled: { type: 'boolean' },
                    polling: { type: 'number', minimum: 100, maximum: 60000, description: 'Polling interval in ms.' }
                }
            }
        },
        {
            name: 'device_update',
            description: 'Update device properties (name, enabled, polling).',
            input_schema: {
                type: 'object',
                required: ['device'],
                properties: {
                    device: { type: 'string', description: 'Current device name or id.' },
                    name: { type: 'string', maxLength: 64 },
                    enabled: { type: 'boolean' },
                    polling: { type: 'number', minimum: 100, maximum: 60000 }
                }
            }
        },
        {
            name: 'device_delete',
            description: 'Delete a device and all its tags. confirmDelete must be true.',
            input_schema: {
                type: 'object',
                required: ['device', 'confirmDelete'],
                properties: {
                    device: { type: 'string' },
                    confirmDelete: { type: 'boolean', enum: [true] }
                }
            }
        },
        {
            name: 'device_enable',
            description: 'Enable or disable a device connection at runtime (does not persist to project).',
            input_schema: {
                type: 'object',
                required: ['device', 'enabled'],
                properties: {
                    device: { type: 'string' },
                    enabled: { type: 'boolean' }
                }
            }
        },
        {
            name: 'tag_list',
            description: 'List tags, optionally filtered by device name and/or query substring. Returns tag id, name, type, address.',
            input_schema: {
                type: 'object',
                properties: {
                    device: { type: 'string', description: 'Filter by device name.' },
                    query: { type: 'string', description: 'Substring filter on tag name.' },
                    limit: { type: 'number', minimum: 1, maximum: 500 }
                }
            }
        },
        {
            name: 'tag_read_value',
            description: 'Read the current live value of one or more tags by name or id.',
            input_schema: {
                type: 'object',
                required: ['tags'],
                properties: {
                    tags: { type: 'array', items: { type: 'string', description: 'Tag name or id.' }, minItems: 1, maxItems: 50 }
                }
            }
        },
        {
            name: 'tag_set_value',
            description: 'Write a value to a tag at runtime.',
            input_schema: {
                type: 'object',
                required: ['tag', 'value'],
                properties: {
                    tag: { type: 'string', description: 'Tag name or id.' },
                    value: { description: 'Value to write (string, number, or boolean).' }
                }
            }
        },
        {
            name: 'tag_history',
            description: 'Query historical values for tags over a time range.',
            input_schema: {
                type: 'object',
                required: ['tags', 'from', 'to'],
                properties: {
                    tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
                    from: { type: 'number', description: 'Start timestamp (ms since epoch).' },
                    to: { type: 'number', description: 'End timestamp (ms since epoch).' }
                }
            }
        },
        {
            name: 'device_update_property',
            description: 'Set protocol-specific connection properties on a device (OPC-UA endpoint, Modbus host/port, MQTT broker, etc). Merges into existing property object.',
            input_schema: {
                type: 'object',
                required: ['device', 'property'],
                properties: {
                    device: { type: 'string', description: 'Device name or id.' },
                    property: {
                        type: 'object',
                        description: 'Protocol connection params. Common fields: address/endpoint (OPC-UA URL, Modbus host), port, rack, slot (Siemens S7), clientId, topic (MQTT), baudRate (serial).',
                        properties: {
                            address: { type: 'string', description: 'Host address, IP, or OPC-UA endpoint URL.' },
                            port: { type: 'number', description: 'TCP/UDP port number.' },
                            endpoint: { type: 'string', description: 'OPC-UA endpoint URL (e.g. opc.tcp://host:4840).' },
                            rack: { type: 'number', description: 'Siemens S7 rack number.' },
                            slot: { type: 'number', description: 'Siemens S7 slot number.' },
                            clientId: { type: 'string', description: 'MQTT client identifier.' },
                            topic: { type: 'string', description: 'MQTT subscription topic.' },
                            baudRate: { type: 'number', description: 'Serial baud rate (ModbusRTU, GPIO).' },
                            dataBits: { type: 'number' },
                            stopBits: { type: 'number' },
                            parity: { type: 'string', enum: ['none', 'even', 'odd'] },
                            unitId: { type: 'number', description: 'Modbus unit/slave id.' },
                            path: { type: 'string', description: 'ADS route path or file path.' },
                            username: { type: 'string' },
                            password: { type: 'string' },
                            securityMode: { type: 'string', description: 'OPC-UA security mode (None, Sign, SignAndEncrypt).' },
                            securityPolicy: { type: 'string', description: 'OPC-UA security policy URI.' }
                        }
                    }
                }
            }
        },
        {
            name: 'tag_add',
            description: 'Add a new tag to a device. Tags represent data points (registers, variables, topics).',
            input_schema: {
                type: 'object',
                required: ['device', 'name', 'address'],
                properties: {
                    device: { type: 'string', description: 'Device name or id to add the tag to.' },
                    name: { type: 'string', maxLength: 128, description: 'Human-readable tag name.' },
                    address: { type: 'string', description: 'Protocol-specific address (e.g. register number, OPC-UA node id, MQTT subtopic).' },
                    type: { type: 'string', description: 'Tag data type. Common: number, string, boolean, float, int.', default: 'number' },
                    initValue: { description: 'Initial value on startup.' },
                    divisor: { type: 'number', description: 'Value divisor for scaling.' },
                    multiply: { type: 'number', description: 'Value multiplier for scaling.' },
                    offset: { type: 'number', description: 'Value offset for calibration.' },
                    unit: { type: 'string', description: 'Engineering unit label (e.g. "°C", "bar", "kW").' },
                    description: { type: 'string', maxLength: 256 }
                }
            }
        }
    ];
}

function executors(ctx) {
    const { runtime, buffer, logger } = ctx;

    return {
        'device_list': async (args = {}) => {
            const devices = runtime?.project?.getDevices?.() || {};
            const q = (args.query || '').toLowerCase();
            return Object.values(devices)
                .filter(d => !q || (d.name || '').toLowerCase().includes(q))
                .map(d => ({
                    id: d.id,
                    name: d.name,
                    type: d.type,
                    enabled: d.enabled,
                    polling: d.polling,
                    tagsCount: Object.keys(d.tags || {}).length
                }));
        },
        'device_read': async (args) => {
            const name = args.device;
            // Try by name first, then by id.
            let dev = runtime?.project?.getDevice?.(name);
            if (!dev) {
                const devices = runtime?.project?.getDevices?.() || {};
                dev = devices[name];
            }
            if (!dev) return { error: 'device_not_found', device: name };
            return {
                id: dev.id,
                name: dev.name,
                type: dev.type,
                enabled: dev.enabled,
                polling: dev.polling,
                tags: Object.entries(dev.tags || {}).map(([tid, t]) => ({
                    id: tid,
                    name: t.name,
                    type: t.type,
                    address: t.address
                }))
            };
        },
        'device_add': async (args) => {
            const devices = runtime?.project?.getDevices?.() || {};
            const existing = Object.values(devices).find(d => d.name === args.name);
            if (existing) return { error: 'device_exists', name: args.name };
            const device = {
                id: genId('dev'),
                name: args.name,
                type: args.type,
                enabled: args.enabled !== false,
                polling: args.polling || 1000,
                tags: {},
                property: {}
            };
            if (!buffer.devicePatch) buffer.devicePatch = [];
            buffer.devicePatch.push({ cmd: 'add', device });
            buffer.dirty = true;
            return { ok: true, id: device.id, name: device.name };
        },
        'device_update': async (args) => {
            const name = args.device;
            let dev = runtime?.project?.getDevice?.(name);
            if (!dev) {
                const devices = runtime?.project?.getDevices?.() || {};
                dev = devices[name];
            }
            if (!dev) return { error: 'device_not_found', device: name };
            const updated = JSON.parse(JSON.stringify(dev));
            if (args.name !== undefined) updated.name = args.name;
            if (args.enabled !== undefined) updated.enabled = args.enabled;
            if (args.polling !== undefined) updated.polling = args.polling;
            if (!buffer.devicePatch) buffer.devicePatch = [];
            buffer.devicePatch.push({ cmd: 'update', device: updated });
            buffer.dirty = true;
            return { ok: true, id: updated.id, name: updated.name };
        },
        'device_delete': async (args) => {
            if (args.confirmDelete !== true) return { error: 'confirm_required' };
            const name = args.device;
            let dev = runtime?.project?.getDevice?.(name);
            if (!dev) {
                const devices = runtime?.project?.getDevices?.() || {};
                dev = Object.values(devices).find(d => d.name === name || d.id === name);
            }
            if (!dev) return { error: 'device_not_found', device: name };
            if (!buffer.devicePatch) buffer.devicePatch = [];
            buffer.devicePatch.push({ cmd: 'delete', device: { id: dev.id, name: dev.name } });
            buffer.dirty = true;
            return { ok: true, deleted: dev.name };
        },
        'device_enable': async (args) => {
            try {
                if (typeof runtime?.devices?.enableDevice === 'function') {
                    runtime.devices.enableDevice(args.device, args.enabled);
                    return { ok: true, device: args.device, enabled: args.enabled };
                }
                return { error: 'device_manager_not_available' };
            } catch (err) {
                return { error: 'enable_failed', message: String(err?.message || err) };
            }
        },
        'tag_list': async (args = {}) => {
            const devices = runtime?.project?.getDevices?.() || {};
            const q = (args.query || '').toLowerCase();
            const limit = args.limit || 100;
            const out = [];
            for (const [did, dev] of Object.entries(devices)) {
                if (args.device && dev.name !== args.device && did !== args.device) continue;
                for (const [tid, t] of Object.entries(dev.tags || {})) {
                    if (q && !(t.name || '').toLowerCase().includes(q)) continue;
                    out.push({ id: tid, name: t.name, device: dev.name, type: t.type, address: t.address });
                    if (out.length >= limit) return out;
                }
            }
            return out;
        },
        'tag_read_value': async (args) => {
            const results = [];
            for (const tagRef of args.tags) {
                let tagId = tagRef;
                // If not found by id, try by name.
                if (typeof runtime?.devices?.getTagValue === 'function') {
                    try {
                        const val = runtime.devices.getTagValue(tagId);
                        results.push({ tag: tagRef, value: val });
                        continue;
                    } catch (_) { /* try by name */ }
                }
                if (typeof runtime?.devices?.getTagId === 'function') {
                    const resolved = runtime.devices.getTagId(tagRef);
                    if (resolved) {
                        try {
                            const val = runtime.devices.getTagValue(resolved);
                            results.push({ tag: tagRef, id: resolved, value: val });
                            continue;
                        } catch (_) { /* fall through */ }
                    }
                }
                results.push({ tag: tagRef, error: 'not_found' });
            }
            return results;
        },
        'tag_set_value': async (args) => {
            try {
                if (typeof runtime?.devices?.setTagValue !== 'function') {
                    return { error: 'device_manager_not_available' };
                }
                // Resolve by name if needed.
                let tagId = args.tag;
                if (typeof runtime.devices.getTagId === 'function') {
                    const resolved = runtime.devices.getTagId(args.tag);
                    if (resolved) tagId = resolved;
                }
                await runtime.devices.setTagValue(tagId, args.value);
                return { ok: true, tag: args.tag, value: args.value };
            } catch (err) {
                return { error: 'set_value_failed', message: String(err?.message || err) };
            }
        },
        'tag_history': async (args) => {
            try {
                if (typeof runtime?.devices?.getHistoricalTags !== 'function') {
                    return { error: 'history_not_available' };
                }
                // Resolve tag names to ids.
                const tagIds = [];
                for (const t of args.tags) {
                    if (typeof runtime.devices.getTagId === 'function') {
                        const resolved = runtime.devices.getTagId(t);
                        tagIds.push(resolved || t);
                    } else {
                        tagIds.push(t);
                    }
                }
                const data = await runtime.devices.getHistoricalTags(tagIds, args.from, args.to);
                return { tags: args.tags, from: args.from, to: args.to, data };
            } catch (err) {
                return { error: 'history_failed', message: String(err?.message || err) };
            }
        },
        'device_update_property': async (args) => {
            const name = args.device;
            let dev = runtime?.project?.getDevice?.(name);
            if (!dev) {
                const devices = runtime?.project?.getDevices?.() || {};
                dev = Object.values(devices).find(d => d.name === name || d.id === name);
            }
            if (!dev) return { error: 'device_not_found', device: name };
            const updated = JSON.parse(JSON.stringify(dev));
            updated.property = updated.property || {};
            // Merge new properties into existing
            for (const [key, val] of Object.entries(args.property)) {
                updated.property[key] = val;
            }
            if (!buffer.devicePatch) buffer.devicePatch = [];
            buffer.devicePatch.push({ cmd: 'update', device: updated });
            buffer.dirty = true;
            return { ok: true, id: updated.id, name: updated.name, property: updated.property };
        },
        'tag_add': async (args) => {
            const name = args.device;
            let dev = runtime?.project?.getDevice?.(name);
            if (!dev) {
                const devices = runtime?.project?.getDevices?.() || {};
                dev = Object.values(devices).find(d => d.name === name || d.id === name);
            }
            if (!dev) return { error: 'device_not_found', device: name };
            // Check for duplicate tag name
            const existing = Object.values(dev.tags || {}).find(t => t.name === args.name);
            if (existing) return { error: 'tag_exists', name: args.name, device: dev.name };
            const tagId = genId('tag');
            const tag = {
                id: tagId,
                name: args.name,
                address: args.address,
                type: args.type || 'number',
                initValue: args.initValue !== undefined ? args.initValue : null,
                divisor: args.divisor || 0,
                multiply: args.multiply || 0,
                offset: args.offset || 0,
                unit: args.unit || '',
                description: args.description || '',
                min: args.min !== undefined ? args.min : null,
                max: args.max !== undefined ? args.max : null
            };
            const updated = JSON.parse(JSON.stringify(dev));
            updated.tags = updated.tags || {};
            updated.tags[tagId] = tag;
            if (!buffer.devicePatch) buffer.devicePatch = [];
            buffer.devicePatch.push({ cmd: 'update', device: updated });
            buffer.dirty = true;
            return { ok: true, tagId, name: tag.name, device: dev.name, address: tag.address };
        }
    };
}

module.exports = { descriptors, executors, DEVICE_TYPES };
