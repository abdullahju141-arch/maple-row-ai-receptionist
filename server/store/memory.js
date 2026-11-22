/**
 * In-memory store with the same interface as the MongoDB store.
 * Used when MONGODB_URI is empty and by the tests. Data is lost on restart.
 */

import crypto from 'node:crypto';

export class DuplicateKeyError extends Error {
	constructor() {
		super('Duplicate key');
		this.code = 11000;
	}
}

function matches(doc, query) {
	for (const [key, condition] of Object.entries(query)) {
		const value = doc[key];
		if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
			for (const [op, arg] of Object.entries(condition)) {
				if (op === '$gte' && !(value >= arg)) return false;
				if (op === '$lte' && !(value <= arg)) return false;
				if (op === '$lt' && !(value < arg)) return false;
				if (op === '$ne' && value === arg) return false;
				if (op === '$in' && !(Array.isArray(value) ? value.some((v) => arg.includes(v)) : arg.includes(value))) return false;
			}
		} else if (Array.isArray(value)) {
			if (!value.includes(condition)) return false;
		} else if (value !== condition) {
			return false;
		}
	}
	return true;
}

function sortDocs(docs, sort = {}) {
	const keys = Object.entries(sort);
	return docs.sort((a, b) => {
		for (const [key, dir] of keys) {
			const av = a[key] instanceof Date ? a[key].getTime() : a[key];
			const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
			if (av < bv) return -dir;
			if (av > bv) return dir;
		}
		return 0;
	});
}

const clone = (doc) => (doc ? structuredClone(doc) : null);

/**
 * @param {(doc: object, rows: object[]) => boolean} [conflicts] Return true if `doc` breaks a unique rule.
 */
function collection(conflicts) {
	const rows = new Map();
	return {
		async find(query = {}, { sort, limit = 0 } = {}) {
			const docs = sortDocs([...rows.values()].filter((d) => matches(d, query)), sort);
			return (limit ? docs.slice(0, limit) : docs).map(clone);
		},
		async count(query = {}) {
			return [...rows.values()].filter((d) => matches(d, query)).length;
		},
		async findOne(query) {
			return clone([...rows.values()].find((d) => matches(d, query)));
		},
		async create(data) {
			const now = new Date();
			const doc = { createdAt: now, ...structuredClone(data), id: crypto.randomBytes(12).toString('hex'), updatedAt: now };
			if (conflicts && conflicts(doc, [...rows.values()])) throw new DuplicateKeyError();
			rows.set(doc.id, doc);
			return clone(doc);
		},
		async update(id, data) {
			const doc = rows.get(String(id));
			if (!doc) return null;
			Object.assign(doc, structuredClone(data), { updatedAt: new Date() });
			return clone(doc);
		},
		async remove(id) {
			return rows.delete(String(id));
		},
		async clear() {
			rows.clear();
		},
	};
}

/** Same rule as the MongoDB partial unique index: booked appointments may not share a slot. */
function slotClash(doc, rows) {
	if (doc.status !== 'booked') return false;
	return rows.some((r) => r.status === 'booked' && r.slotKeys.some((k) => doc.slotKeys.includes(k)));
}

export async function createMemoryStore() {
	return {
		kind: 'memory',
		appointments: collection(slotClash),
		messages: collection(),
		calls: collection(),
		async close() {},
	};
}
