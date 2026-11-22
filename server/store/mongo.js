/**
 * MongoDB store (Mongoose). Loaded only when MONGODB_URI is set.
 */

import mongoose from 'mongoose';

const appointmentSchema = new mongoose.Schema(
	{
		reference: { type: String, required: true, unique: true },
		patientName: { type: String, required: true },
		phone: { type: String, required: true },
		phoneDigits: { type: String, required: true, index: true },
		service: { type: String, required: true },
		serviceLabel: String,
		withId: String,
		date: { type: String, required: true, index: true },
		time: { type: String, required: true },
		minutes: Number,
		slotKeys: [String],
		newPatient: Boolean,
		notes: String,
		status: { type: String, enum: ['booked', 'cancelled'], default: 'booked', index: true },
		source: { type: String, default: 'ai-call' },
		demo: { type: Boolean, default: false },
		// Visitors' demo data is removed automatically a week after the appointment date.
		expiresAt: { type: Date, index: { expires: 0 } },
	},
	{ timestamps: true },
);
// Two booked appointments can never share a 30-minute slot, even if two calls book at once.
appointmentSchema.index({ slotKeys: 1 }, { unique: true, partialFilterExpression: { status: 'booked' } });

const messageSchema = new mongoose.Schema(
	{
		name: String,
		phone: String,
		message: String,
		urgent: Boolean,
		status: { type: String, enum: ['new', 'handled'], default: 'new' },
		expiresAt: { type: Date, index: { expires: 0 } },
	},
	{ timestamps: true },
);

const callSchema = new mongoose.Schema(
	{
		startedAt: Date,
		endedAt: Date,
		seconds: Number,
		endReason: String,
		toolsUsed: [String],
		booked: [String],
		expiresAt: { type: Date, index: { expires: 0 } },
	},
	{ timestamps: true },
);

function plain(doc) {
	if (!doc) return null;
	const { _id, __v, ...rest } = doc;
	return { id: String(_id), ...rest };
}

function wrap(Model) {
	const isId = (id) => mongoose.isValidObjectId(id);
	return {
		async find(query = {}, { sort, limit = 0 } = {}) {
			let q = Model.find(query).lean();
			if (sort) q = q.sort(sort);
			if (limit) q = q.limit(limit);
			return (await q).map(plain);
		},
		async count(query = {}) {
			return Model.countDocuments(query);
		},
		async findOne(query) {
			return plain(await Model.findOne(query).lean());
		},
		async create(data) {
			return plain((await Model.create(data)).toObject());
		},
		async update(id, data) {
			if (!isId(id)) return null;
			return plain(await Model.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean());
		},
		async remove(id) {
			if (!isId(id)) return false;
			return Boolean(await Model.findByIdAndDelete(id));
		},
		async clear() {
			await Model.deleteMany({});
		},
	};
}

export async function createMongoStore(uri) {
	mongoose.set('strictQuery', true);
	await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
	const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
	const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
	const Call = mongoose.models.Call || mongoose.model('Call', callSchema);
	await Appointment.syncIndexes();
	return {
		kind: 'mongo',
		appointments: wrap(Appointment),
		messages: wrap(Message),
		calls: wrap(Call),
		async close() {
			await mongoose.disconnect();
		},
	};
}
