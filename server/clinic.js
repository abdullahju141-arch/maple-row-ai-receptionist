/**
 * Facts about the (fictional) clinic. The receptionist may only answer from these.
 * Kept in sync with the Maple Row Dental WordPress demo.
 */

export const CLINIC = {
	name: 'Maple Row Dental',
	receptionist: 'Ava',
	phone: '(217) 555-0142',
	email: 'hello@maplerowdental.example',
	address: '24 Maple Row, Suite 3, Springfield, IL 62704',
	timeZone: 'America/Chicago',
	opened: 2012,
	parking: 'Free parking behind the building, entrance on Elm Street.',
};

/** Opening hours by weekday (0 = Sunday). null = closed. */
export const HOURS = {
	0: null,
	1: ['09:00', '18:00'],
	2: ['09:00', '18:00'],
	3: ['09:00', '18:00'],
	4: ['09:00', '18:00'],
	5: ['09:00', '18:00'],
	6: ['10:00', '14:00'],
};

export const HOURS_TEXT = 'Monday to Friday 9am to 6pm, Saturday 10am to 2pm, closed on Sunday';

export const TEAM = [
	{ id: 'reed', name: 'Dr. Hannah Reed', role: 'Lead dentist and owner' },
	{ id: 'ellison', name: 'Dr. Mark Ellison', role: 'Implants and restorative dentistry' },
	{ id: 'marin', name: 'Sofia Marin', role: 'Dental hygienist' },
];

/**
 * Bookable services. `minutes` is the appointment length (multiples of 30).
 * `with` is the team member who usually sees the patient.
 */
export const SERVICES = {
	'new-patient-exam': { label: 'New patient exam with X-rays', short: 'New patient exam', minutes: 60, price: '$89', with: 'reed' },
	'checkup-clean': { label: 'Check-up and clean', short: 'Check-up & clean', minutes: 60, price: '$120', with: 'marin' },
	emergency: { label: 'Emergency appointment', short: 'Emergency', minutes: 30, price: '$75', with: 'reed' },
	filling: { label: 'White filling', short: 'Filling', minutes: 60, price: 'from $140', with: 'reed' },
	whitening: { label: 'Teeth whitening consultation', short: 'Whitening consult', minutes: 30, price: 'whitening from $290', with: 'reed' },
	crown: { label: 'Crown consultation', short: 'Crown consult', minutes: 30, price: 'crowns from $950', with: 'ellison' },
	implant: { label: 'Implant consultation', short: 'Implant consult', minutes: 30, price: 'implants from $2,400', with: 'ellison' },
	aligners: { label: 'Clear aligners consultation', short: 'Aligners consult', minutes: 30, price: 'aligners from $2,900', with: 'reed' },
	'child-checkup': { label: "Children's check-up", short: 'Child check-up', minutes: 30, price: '$65', with: 'reed' },
};

export const FAQ = [
	['How soon can I be seen?', 'New patients usually get an appointment within three working days. People in pain should call before 10am for a same-day emergency slot.'],
	['How long is a first visit?', 'About 45 minutes to an hour: exam, X-rays if needed, and a conversation about what we found.'],
	['What should I bring?', 'Photo ID, your insurance card if you have one, and a list of any medication you take.'],
	['Cancellations', 'Please give 24 hours notice so the slot can go to someone else.'],
	['Insurance', 'We work with most major PPO plans and file the claim for you. Staff can check a specific plan before treatment.'],
	['Prices', 'Prices are guide prices. You get a written quote after your exam and before any treatment starts.'],
	['Payment plans', 'Treatment over $500 can be spread over 6 or 12 months, interest-free.'],
	['No insurance', 'There is a yearly membership plan covering two check-ups and cleans with a discount on other treatment.'],
	['Nervous patients', 'Tell us when you book: you get a longer slot, every step is explained, and you can stop at any time by raising a hand.'],
	['Children', 'Children are seen from their first tooth. Early visits are short and gentle.'],
	['Whitening safety', 'Safe when a dentist checks your teeth first and supervises it. Some people get temporary sensitivity.'],
];

export function teamMember(id) {
	return TEAM.find((m) => m.id === id) || TEAM[0];
}
