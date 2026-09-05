/** Shared display constants for leads: stages, temperature, lead type badges. */

export const STAGES = [
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'nurturing', label: 'Nurturing' },
  { id: 'appointment_set', label: 'Appointment Set' },
  { id: 'under_contract', label: 'Under Contract' },
  { id: 'closed_won', label: 'Closed Won' },
  { id: 'closed_lost', label: 'Closed Lost' },
];

export const STAGE_LABELS = Object.fromEntries(STAGES.map(s => [s.id, s.label]));

export const TEMPERATURE_META = {
  hot: { label: 'Hot', dot: 'bg-hot-500', badge: 'bg-hot-100 text-hot-700', ring: 'ring-hot-200' },
  warm: { label: 'Warm', dot: 'bg-warm-500', badge: 'bg-warm-100 text-warm-700', ring: 'ring-warm-200' },
  cold: { label: 'Cold', dot: 'bg-cold-500', badge: 'bg-cold-100 text-cold-700', ring: 'ring-cold-200' },
};

export const LEAD_TYPE_META = {
  buyer: { label: 'Buyer', badge: 'bg-violet-100 text-violet-700' },
  seller: { label: 'Seller', badge: 'bg-primary-100 text-primary-700' },
};

export const STAGE_BADGE = {
  new: 'bg-neutral-100 text-neutral-600',
  contacted: 'bg-sky-100 text-sky-700',
  nurturing: 'bg-indigo-100 text-indigo-700',
  appointment_set: 'bg-amber-100 text-amber-700',
  under_contract: 'bg-emerald-100 text-emerald-700',
  closed_won: 'bg-green-100 text-green-700',
  closed_lost: 'bg-red-100 text-red-600',
};

export function temperatureBadge(t) {
  const m = TEMPERATURE_META[t] || TEMPERATURE_META.warm;
  return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${m.badge}"><span class="w-1.5 h-1.5 rounded-full ${m.dot}"></span>${m.label}</span>`;
}
export function leadTypeBadge(t) {
  const m = LEAD_TYPE_META[t] || LEAD_TYPE_META.buyer;
  return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${m.badge}">${m.label}</span>`;
}
export function stageBadge(s) {
  const cls = STAGE_BADGE[s] || 'bg-neutral-100 text-neutral-600';
  return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${cls}">${STAGE_LABELS[s] || s}</span>`;
}
