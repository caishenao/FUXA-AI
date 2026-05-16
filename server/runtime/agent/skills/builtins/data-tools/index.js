/**
 * data-tools — trend queries, stats, comparison, anomaly detection.
 */
'use strict';

function descriptors() {
    return [
        {
            name: 'tag_trend',
            description: 'Query historical trend data for a tag over a time range.',
            input_schema: {
                type: 'object',
                required: ['deviceId', 'tagId', 'from', 'to'],
                properties: {
                    deviceId: { type: 'string', description: 'Device ID' },
                    tagId: { type: 'string', description: 'Tag ID within the device' },
                    from: { type: 'string', description: 'Start time (ISO 8601 or relative like -1h, -24h, -7d)' },
                    to: { type: 'string', description: 'End time (ISO 8601 or "now")' },
                    aggregate: { type: 'string', enum: ['raw', 'avg', 'min', 'max', 'sum', 'count'], description: 'Aggregation method (default raw)' },
                    interval: { type: 'string', description: 'Aggregate interval (e.g. 1m, 5m, 1h). Required when aggregate is not raw.' }
                }
            }
        },
        {
            name: 'tag_stats',
            description: 'Calculate statistics (min, max, avg, count) for a tag over a time range.',
            input_schema: {
                type: 'object',
                required: ['deviceId', 'tagId', 'from', 'to'],
                properties: {
                    deviceId: { type: 'string', description: 'Device ID' },
                    tagId: { type: 'string', description: 'Tag ID' },
                    from: { type: 'string', description: 'Start time (ISO 8601 or relative)' },
                    to: { type: 'string', description: 'End time (ISO 8601 or "now")' }
                }
            }
        },
        {
            name: 'tag_compare',
            description: 'Compare values of multiple tags over the same time range.',
            input_schema: {
                type: 'object',
                required: ['tags', 'from', 'to'],
                properties: {
                    tags: {
                        type: 'array',
                        description: 'List of {deviceId, tagId} pairs to compare',
                        items: {
                            type: 'object',
                            required: ['deviceId', 'tagId'],
                            properties: {
                                deviceId: { type: 'string' },
                                tagId: { type: 'string' },
                                label: { type: 'string', description: 'Display label (optional)' }
                            }
                        }
                    },
                    from: { type: 'string', description: 'Start time' },
                    to: { type: 'string', description: 'End time' }
                }
            }
        },
        {
            name: 'export_csv',
            description: 'Export tag data as CSV text for a time range.',
            input_schema: {
                type: 'object',
                required: ['deviceId', 'tagId', 'from', 'to'],
                properties: {
                    deviceId: { type: 'string' },
                    tagId: { type: 'string' },
                    from: { type: 'string', description: 'Start time' },
                    to: { type: 'string', description: 'End time' },
                    delimiter: { type: 'string', description: 'CSV delimiter (default comma)' }
                }
            }
        },
        {
            name: 'anomaly_detect',
            description: 'Detect anomalies (spikes, drops, drift) in a tag value over a time range.',
            input_schema: {
                type: 'object',
                required: ['deviceId', 'tagId', 'from', 'to'],
                properties: {
                    deviceId: { type: 'string' },
                    tagId: { type: 'string' },
                    from: { type: 'string', description: 'Start time' },
                    to: { type: 'string', description: 'End time' },
                    threshold: { type: 'number', description: 'Standard deviations for anomaly (default 2.5)' }
                }
            }
        }
    ];
}

function executors(ctx) {
    const runtime = ctx?.runtime;
    const logger = ctx?.logger;

    async function _getTagHistory(deviceId, tagId, from, to) {
        const project = runtime?.project;
        if (!project) return [];
        const tagHist = project.getTagHistory || project.getTagValues;
        if (typeof tagHist !== 'function') return [];
        try {
            return await tagHist.call(project, deviceId, tagId, from, to) || [];
        } catch (err) {
            logger?.warn?.(`data-tools: tag_history error: ${err.message}`);
            return [];
        }
    }

    function _parseTime(t) {
        if (!t || t === 'now') return Date.now();
        const rel = t.match(/^-(\d+)([smhd])$/);
        if (rel) {
            const val = parseInt(rel[1], 10);
            const unit = rel[2];
            const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 1000;
            return Date.now() - val * ms;
        }
        const d = new Date(t);
        return isNaN(d.getTime()) ? Date.now() : d.getTime();
    }

    function _aggregate(values, method) {
        if (!values.length) return null;
        const nums = values.map(v => Number(v.value)).filter(n => !isNaN(n));
        if (!nums.length) return null;
        switch (method) {
            case 'min': return Math.min(...nums);
            case 'max': return Math.max(...nums);
            case 'sum': return nums.reduce((a, b) => a + b, 0);
            case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
            case 'count': return nums.length;
            default: return nums[nums.length - 1];
        }
    }

    return {
        async tag_trend(args) {
            const from = _parseTime(args.from);
            const to = _parseTime(args.to);
            const data = await _getTagHistory(args.deviceId, args.tagId, from, to);
            if (!data.length) return { points: [], message: 'No data found' };

            if (args.aggregate && args.aggregate !== 'raw') {
                const intervalMs = _parseInterval(args.interval || '5m');
                const buckets = new Map();
                for (const pt of data) {
                    const key = Math.floor(pt.timestamp / intervalMs) * intervalMs;
                    if (!buckets.has(key)) buckets.set(key, []);
                    buckets.get(key).push(pt);
                }
                const points = [];
                for (const [ts, bucket] of buckets) {
                    points.push({ timestamp: ts, value: _aggregate(bucket, args.aggregate) });
                }
                return { points, aggregated: true, method: args.aggregate, count: points.length };
            }
            return { points: data.slice(0, 500), aggregated: false, count: data.length };
        },

        async tag_stats(args) {
            const from = _parseTime(args.from);
            const to = _parseTime(args.to);
            const data = await _getTagHistory(args.deviceId, args.tagId, from, to);
            if (!data.length) return { count: 0, message: 'No data found' };
            const nums = data.map(v => Number(v.value)).filter(n => !isNaN(n));
            if (!nums.length) return { count: 0, message: 'No numeric values' };
            return {
                count: nums.length,
                min: Math.min(...nums),
                max: Math.max(...nums),
                avg: nums.reduce((a, b) => a + b, 0) / nums.length,
                sum: nums.reduce((a, b) => a + b, 0),
                first: data[0],
                last: data[data.length - 1]
            };
        },

        async tag_compare(args) {
            const from = _parseTime(args.from);
            const to = _parseTime(args.to);
            const results = [];
            for (const tag of args.tags) {
                const data = await _getTagHistory(tag.deviceId, tag.tagId, from, to);
                const nums = data.map(v => Number(v.value)).filter(n => !isNaN(n));
                results.push({
                    deviceId: tag.deviceId,
                    tagId: tag.tagId,
                    label: tag.label || `${tag.deviceId}/${tag.tagId}`,
                    count: nums.length,
                    avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
                    min: nums.length ? Math.min(...nums) : null,
                    max: nums.length ? Math.max(...nums) : null
                });
            }
            return { results, from: args.from, to: args.to };
        },

        async export_csv(args) {
            const from = _parseTime(args.from);
            const to = _parseTime(args.to);
            const data = await _getTagHistory(args.deviceId, args.tagId, from, to);
            const delim = args.delimiter || ',';
            const lines = ['timestamp' + delim + 'value'];
            for (const pt of data) {
                lines.push(new Date(pt.timestamp).toISOString() + delim + pt.value);
            }
            return { csv: lines.join('\n'), rowCount: data.length };
        },

        async anomaly_detect(args) {
            const from = _parseTime(args.from);
            const to = _parseTime(args.to);
            const data = await _getTagHistory(args.deviceId, args.tagId, from, to);
            if (data.length < 10) return { anomalies: [], message: 'Not enough data points (need >= 10)' };

            const nums = data.map(v => Number(v.value)).filter(n => !isNaN(n));
            const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
            const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
            const std = Math.sqrt(variance);
            const threshold = args.threshold || 2.5;
            const limit = mean + std * threshold;
            const floor = mean - std * threshold;

            const anomalies = [];
            for (let i = 0; i < data.length; i++) {
                const v = Number(data[i].value);
                if (isNaN(v)) continue;
                if (v > limit || v < floor) {
                    anomalies.push({
                        timestamp: data[i].timestamp,
                        value: v,
                        type: v > limit ? 'spike' : 'drop',
                        deviation: std > 0 ? ((v - mean) / std).toFixed(2) + 'σ' : 'N/A'
                    });
                }
            }
            return {
                anomalies: anomalies.slice(0, 50),
                totalAnomalies: anomalies.length,
                baseline: { mean, std, threshold },
                dataPoints: nums.length
            };
        }
    };
}

function _parseInterval(s) {
    const m = String(s).match(/^(\d+)([smhd])$/);
    if (!m) return 300000;
    const val = parseInt(m[1], 10);
    return val * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]] || 60000);
}

module.exports = { descriptors, executors };
